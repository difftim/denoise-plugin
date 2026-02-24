import createRNNWasmModuleSync from "./dist/rnnoise-sync.js"
import createDeepFilterWasmModuleSync from "./dist/deepfilter-sync.js"
import {
    CONTROL_DESTROY_INDEX,
    CONTROL_ENABLED_INDEX,
    CONTROL_RING_CAPACITY_INDEX,
    CONTROL_SIGNAL_INDEX,
    CONTROL_WORKER_READY_INDEX,
    QUANTUM_SAMPLES,
    REQUIRED_SAMPLE_RATE,
    RNNOISE_FRAME,
    SharedBufferPayload,
    SharedRingBufferView,
    clearSharedRing,
    createSharedRingBufferView,
    getSharedRingAvailableFrames,
    pullFromSharedRing,
    pushToSharedRing,
} from "./sharedMemory"

const RNNOISE_SCALE = 32768
const WAIT_TIMEOUT_MS = 50
const MAX_BLOCKS_PER_TICK = 96
const DEFAULT_VAD_LOG_INTERVAL_MS = 1000
const DEFAULT_DENOISER_ENGINE: DenoiserEngine = "rnnoise"
const DEFAULT_DF_ATTEN_LIM_DB = 100
const DEFAULT_DF_POST_FILTER_BETA = 0

interface IRnnoiseModule extends EmscriptenModule {
    _malloc: (size: number) => number
    _free: (pointer: number) => void
    _rnnoise_create: () => number
    _rnnoise_destroy: (context: number) => void
    _rnnoise_process_frame: (context: number, output: number, input: number) => number
}

type DenoiserEngine = "rnnoise" | "deepfilternet"

interface DeepFilterOptions {
    jsUrl?: string
    wasmUrl?: string
    modelUrl?: string
    attenLimDb?: number
    postFilterBeta?: number
}

interface ResolvedDeepFilterOptions {
    modelUrl?: string
    attenLimDb: number
    postFilterBeta: number
}

interface MainToWorkerMessage {
    message: string
    sampleRate?: number
    enable?: boolean
    debugLogs?: boolean
    vadLogs?: boolean
    bufferOverflowMs?: number
    engine?: DenoiserEngine
    deepFilter?: DeepFilterOptions
    sharedBuffers?: SharedBufferPayload
    error?: string
}

interface WorkerGlobalLike {
    onmessage: ((event: MessageEvent<MainToWorkerMessage>) => void) | null
    postMessage: (message: unknown, transfer?: Transferable[]) => void
}

interface DeepFilterBindings {
    initSync: (module: BufferSource | WebAssembly.Module) => unknown
    df_create: (modelBytes: Uint8Array, attenLimDb: number) => number
    df_create_default: (attenLimDb: number) => number
    df_destroy: (state: number) => void
    df_get_frame_length: (state: number) => number
    df_process_frame: (state: number, input: Float32Array) => Float32Array
    df_set_atten_lim: (state: number, limDb: number) => void
    df_set_post_filter_beta: (state: number, beta: number) => void
}

class MonoRingBuffer {
    private readonly _data: Float32Array
    private _readIndex = 0
    private _writeIndex = 0
    private _framesAvailable = 0

    constructor(capacity: number) {
        this._data = new Float32Array(capacity)
    }

    get framesAvailable(): number {
        return this._framesAvailable
    }

    push(input: Float32Array): number {
        let overwritten = 0

        for (let i = 0; i < input.length; i += 1) {
            this._data[this._writeIndex] = input[i]
            this._writeIndex = (this._writeIndex + 1) % this._data.length

            if (this._framesAvailable < this._data.length) {
                this._framesAvailable += 1
            } else {
                this._readIndex = (this._readIndex + 1) % this._data.length
                overwritten += 1
            }
        }

        return overwritten
    }

    pullMono(target: Float32Array): boolean {
        if (this._framesAvailable < target.length) {
            return false
        }

        for (let i = 0; i < target.length; i += 1) {
            target[i] = this._data[this._readIndex]
            this._readIndex = (this._readIndex + 1) % this._data.length
        }

        this._framesAvailable -= target.length
        return true
    }

    clear() {
        this._readIndex = 0
        this._writeIndex = 0
        this._framesAvailable = 0
        this._data.fill(0)
    }
}

class DenoiserWorkerRuntime {
    private readonly _global: WorkerGlobalLike
    private _messageChain: Promise<void> = Promise.resolve()

    private _initialized = false
    private _shouldDenoise = true
    private _sampleRate = REQUIRED_SAMPLE_RATE
    private _destroyRequested = false
    private _loopRunning = false
    private _lastSignalValue = 0
    private _debugLogs = false
    private _vadLogs = false
    private _vadLogIntervalMs = DEFAULT_VAD_LOG_INTERVAL_MS
    private _lastVadLogAtMs = 0

    private _sharedInput?: SharedRingBufferView
    private _sharedOutput?: SharedRingBufferView
    private _sharedControl?: Int32Array

    private _engine: DenoiserEngine = DEFAULT_DENOISER_ENGINE
    private _algorithmFrameLength = RNNOISE_FRAME

    private _rnWasmInterface?: IRnnoiseModule
    private _rnContext = 0
    private _rnInputPtr = 0
    private _rnOutputPtr = 0
    private _rnInputHeap?: Float32Array
    private _rnOutputHeap?: Float32Array

    private _deepFilterBindings?: DeepFilterBindings
    private _deepFilterState = 0
    private _deepFilterOptions: ResolvedDeepFilterOptions = {
        attenLimDb: DEFAULT_DF_ATTEN_LIM_DB,
        postFilterBeta: DEFAULT_DF_POST_FILTER_BETA,
    }

    private _processBlockLength = QUANTUM_SAMPLES
    private _processInputBlock = new Float32Array(QUANTUM_SAMPLES)
    private _processOutputBlock = new Float32Array(QUANTUM_SAMPLES)
    private _inputQueue = new MonoRingBuffer(64 * Math.max(RNNOISE_FRAME, QUANTUM_SAMPLES))
    private _outputQueue = new MonoRingBuffer(64 * Math.max(RNNOISE_FRAME, QUANTUM_SAMPLES))
    private _inputFrame = new Float32Array(RNNOISE_FRAME)
    private _outputFrame = new Float32Array(RNNOISE_FRAME)

    constructor(globalRef: WorkerGlobalLike) {
        this._global = globalRef
    }

    handleMainMessage(payload: MainToWorkerMessage) {
        this._messageChain = this._messageChain
            .then(async () => {
                await this._handleMainMessage(payload)
            })
            .catch((error) => {
                this._reportError(error)
                this.destroy()
            })
    }

    private async _handleMainMessage(payload: MainToWorkerMessage) {
        if (!payload?.message) {
            return
        }

        switch (payload.message) {
            case "ATTACH_SHARED_BUFFERS": {
                if (payload.sharedBuffers) {
                    this._attachSharedBuffers(payload.sharedBuffers)
                }
                break
            }
            case "INIT": {
                await this._init(payload)
                break
            }
            case "SET_ENABLED": {
                this._setEnabled(payload.enable ?? this._shouldDenoise)
                break
            }
            case "UPDATE_DEEPFILTER_PARAMS": {
                this._updateDeepFilterParams(payload.deepFilter)
                break
            }
            case "DESTROY": {
                this.destroy()
                break
            }
            default:
                break
        }
    }

    private _attachSharedBuffers(sharedBuffers: SharedBufferPayload) {
        this._sharedInput = createSharedRingBufferView(
            sharedBuffers.inputState,
            sharedBuffers.inputData,
        )
        this._sharedOutput = createSharedRingBufferView(
            sharedBuffers.outputState,
            sharedBuffers.outputData,
        )
        this._sharedControl = new Int32Array(sharedBuffers.controlState)

        const sharedCapacity = Atomics.load(this._sharedControl, CONTROL_RING_CAPACITY_INDEX)
        if (sharedCapacity > 0 && sharedCapacity !== this._sharedInput.capacity) {
            throw new Error(
                `Shared ring capacity mismatch. control=${sharedCapacity}, input=${this._sharedInput.capacity}`,
            )
        }

        Atomics.store(this._sharedControl, CONTROL_WORKER_READY_INDEX, 0)
        Atomics.add(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)
        Atomics.notify(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)

        this._resetQueues()
        clearSharedRing(this._sharedInput)
        clearSharedRing(this._sharedOutput)
    }

    private async _init(payload: MainToWorkerMessage) {
        if (this._initialized) {
            this._releaseRuntime(false)
        }

        if (!this._sharedInput || !this._sharedOutput || !this._sharedControl) {
            throw new Error("Shared buffers are not attached")
        }

        this._sampleRate = this._resolveSampleRate(payload.sampleRate)
        this._debugLogs = payload.debugLogs ?? false
        this._vadLogs = payload.vadLogs ?? false
        this._vadLogIntervalMs = this._resolveVadLogIntervalMs(payload.bufferOverflowMs)
        this._lastVadLogAtMs = 0
        this._engine = this._resolveEngine(payload.engine)

        if (this._sampleRate !== REQUIRED_SAMPLE_RATE) {
            throw new Error(
                `Unsupported sampleRate ${this._sampleRate}. Worker currently requires ${REQUIRED_SAMPLE_RATE}.`,
            )
        }

        this._destroyRequested = false
        await this._initializeBackend(payload)
        this._resetQueues()
        this._initialized = true
        this._setEnabled(this._readEnabledFlag())
        Atomics.store(this._sharedControl, CONTROL_WORKER_READY_INDEX, 1)
        Atomics.add(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)
        Atomics.notify(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)
        this._startLoop()

        if (this._debugLogs) {
            this._global.postMessage({
                message:
                    this._engine === "deepfilternet"
                        ? "DENOISER_WORKER_DF_READY"
                        : "DENOISER_WORKER_RN_READY",
            })
        }
    }

    private async _initializeBackend(payload: MainToWorkerMessage) {
        this._algorithmFrameLength = RNNOISE_FRAME

        if (this._engine === "deepfilternet") {
            const options = this._resolveDeepFilterOptions(payload.deepFilter)
            this._deepFilterOptions = options
            await this._initializeDeepFilterBackend(options)
            return
        }

        this._initializeRnnoiseBackend()
    }

    private _initializeRnnoiseBackend() {
        this._rnWasmInterface = createRNNWasmModuleSync() as IRnnoiseModule
        this._rnContext = this._rnWasmInterface._rnnoise_create()

        if (!this._rnContext) {
            throw new Error("Failed to initialize RNNoise context")
        }

        this._rnInputPtr = this._rnWasmInterface._malloc(
            RNNOISE_FRAME * Float32Array.BYTES_PER_ELEMENT,
        )
        this._rnOutputPtr = this._rnWasmInterface._malloc(
            RNNOISE_FRAME * Float32Array.BYTES_PER_ELEMENT,
        )

        if (!this._rnInputPtr || !this._rnOutputPtr) {
            throw new Error("Failed to allocate RNNoise heap buffers")
        }

        const heapOffsetInput = this._rnInputPtr >> 2
        const heapOffsetOutput = this._rnOutputPtr >> 2

        this._rnInputHeap = this._rnWasmInterface.HEAPF32.subarray(
            heapOffsetInput,
            heapOffsetInput + RNNOISE_FRAME,
        )
        this._rnOutputHeap = this._rnWasmInterface.HEAPF32.subarray(
            heapOffsetOutput,
            heapOffsetOutput + RNNOISE_FRAME,
        )

        this._algorithmFrameLength = RNNOISE_FRAME
    }

    private async _initializeDeepFilterBackend(options: ResolvedDeepFilterOptions) {
        this._deepFilterBindings = createDeepFilterWasmModuleSync() as DeepFilterBindings

        const state = await this._createDeepFilterState(options)
        if (!state) {
            throw new Error("Failed to create DeepFilterNet state")
        }

        this._deepFilterState = state
        const frameLength = this._deepFilterBindings.df_get_frame_length(state)
        if (!Number.isFinite(frameLength) || frameLength <= 0) {
            throw new Error(`Invalid DeepFilterNet frame length: ${frameLength}`)
        }

        this._algorithmFrameLength = frameLength
        this._applyDeepFilterParams(options.attenLimDb, options.postFilterBeta)
    }

    private async _createDeepFilterState(options: ResolvedDeepFilterOptions): Promise<number> {
        if (!this._deepFilterBindings) {
            throw new Error("DeepFilterNet bindings are missing")
        }

        if (options.modelUrl) {
            const modelBytes = await this._loadDeepFilterModel(options.modelUrl)
            return this._deepFilterBindings.df_create(modelBytes, options.attenLimDb)
        }

        return this._deepFilterBindings.df_create_default(options.attenLimDb)
    }

    private async _loadDeepFilterModel(modelUrl: string): Promise<Uint8Array> {
        const response = await fetch(modelUrl)
        if (!response.ok) {
            throw new Error(`Failed to fetch DeepFilter model: ${response.status} ${response.statusText}`)
        }

        const modelBuffer = await response.arrayBuffer()
        return new Uint8Array(modelBuffer)
    }

    private _startLoop() {
        if (this._loopRunning || !this._initialized || !this._sharedControl) {
            return
        }

        this._loopRunning = true
        this._lastSignalValue = Atomics.load(this._sharedControl, CONTROL_SIGNAL_INDEX)

        queueMicrotask(() => {
            try {
                this._runLoop()
            } catch (error) {
                this._reportError(error)
                this.destroy()
            }
        })
    }

    private _runLoop() {
        if (!this._sharedControl) {
            this._loopRunning = false
            return
        }

        while (this._loopRunning && !this._destroyRequested) {
            if (Atomics.load(this._sharedControl, CONTROL_DESTROY_INDEX) === 1) {
                this._destroyRequested = true
                break
            }

            this._shouldDenoise = this._readEnabledFlag()
            const processedAny = this._processAvailableBlocks()

            if (this._destroyRequested) {
                break
            }

            if (!processedAny) {
                const expected = this._lastSignalValue
                Atomics.wait(this._sharedControl, CONTROL_SIGNAL_INDEX, expected, WAIT_TIMEOUT_MS)
            }

            this._lastSignalValue = Atomics.load(this._sharedControl, CONTROL_SIGNAL_INDEX)
        }

        this._loopRunning = false

        if (
            this._destroyRequested ||
            Atomics.load(this._sharedControl, CONTROL_DESTROY_INDEX) === 1
        ) {
            this._releaseRuntime(false)
        }
    }

    private _setEnabled(enable: boolean) {
        this._shouldDenoise = enable
        this._lastVadLogAtMs = 0

        if (this._sharedControl) {
            Atomics.store(this._sharedControl, CONTROL_ENABLED_INDEX, enable ? 1 : 0)
            Atomics.add(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)
            Atomics.notify(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)
        }

        this._resetQueues()
        if (this._sharedInput && this._sharedOutput) {
            clearSharedRing(this._sharedInput)
            clearSharedRing(this._sharedOutput)
        }
    }

    private _updateDeepFilterParams(options?: DeepFilterOptions) {
        if (!options) {
            return
        }

        if (options.modelUrl !== undefined) {
            this._deepFilterOptions.modelUrl =
                typeof options.modelUrl === "string" && options.modelUrl.trim().length > 0
                    ? options.modelUrl
                    : undefined
        }
        if (options.attenLimDb !== undefined) {
            this._deepFilterOptions.attenLimDb = this._resolveDeepFilterAttenLimDb(options.attenLimDb)
        }
        if (options.postFilterBeta !== undefined) {
            this._deepFilterOptions.postFilterBeta = this._resolveDeepFilterPostFilterBeta(
                options.postFilterBeta,
            )
        }

        if (this._engine === "deepfilternet" && this._deepFilterState && this._deepFilterBindings) {
            this._applyDeepFilterParams(
                this._deepFilterOptions.attenLimDb,
                this._deepFilterOptions.postFilterBeta,
            )
        }
    }

    private _applyDeepFilterParams(attenLimDb: number, postFilterBeta: number) {
        if (!this._deepFilterBindings || !this._deepFilterState) {
            return
        }

        this._deepFilterBindings.df_set_atten_lim(this._deepFilterState, attenLimDb)
        this._deepFilterBindings.df_set_post_filter_beta(this._deepFilterState, postFilterBeta)
    }

    private _processAvailableBlocks(): boolean {
        if (!this._initialized || !this._sharedInput || !this._sharedOutput) {
            return false
        }

        let processedAny = false
        let processedBlocks = 0

        while (
            processedBlocks < MAX_BLOCKS_PER_TICK &&
            getSharedRingAvailableFrames(this._sharedInput) >= this._processBlockLength
        ) {
            if (!pullFromSharedRing(this._sharedInput, this._processInputBlock)) {
                break
            }

            processedAny = true
            processedBlocks += 1

            if (!this._shouldDenoise) {
                pushToSharedRing(this._sharedOutput, this._processInputBlock)
                continue
            }

            this._inputQueue.push(this._processInputBlock)

            while (
                this._inputQueue.framesAvailable >= this._algorithmFrameLength &&
                this._inputQueue.pullMono(this._inputFrame)
            ) {
                this._processCurrentFrame()
                this._outputQueue.push(this._outputFrame)
            }

            while (this._outputQueue.framesAvailable >= this._processBlockLength) {
                if (!this._outputQueue.pullMono(this._processOutputBlock)) {
                    break
                }

                pushToSharedRing(this._sharedOutput, this._processOutputBlock)
            }
        }

        return processedAny
    }

    private _processCurrentFrame() {
        if (this._engine === "deepfilternet") {
            this._processDeepFilterFrame()
            return
        }

        this._processRnnoiseFrame()
    }

    private _processRnnoiseFrame() {
        if (
            !this._rnWasmInterface ||
            !this._rnContext ||
            !this._rnInputHeap ||
            !this._rnOutputHeap ||
            !this._rnInputPtr ||
            !this._rnOutputPtr
        ) {
            return
        }

        for (let i = 0; i < RNNOISE_FRAME; i += 1) {
            this._rnInputHeap[i] = this._inputFrame[i] * RNNOISE_SCALE
        }

        const vadScore = this._rnWasmInterface._rnnoise_process_frame(
            this._rnContext,
            this._rnOutputPtr,
            this._rnInputPtr,
        )
        this._maybeEmitVadLog(vadScore)

        for (let i = 0; i < RNNOISE_FRAME; i += 1) {
            this._outputFrame[i] = this._rnOutputHeap[i] / RNNOISE_SCALE
        }
    }

    private _processDeepFilterFrame() {
        if (!this._deepFilterBindings || !this._deepFilterState) {
            throw new Error("DeepFilterNet runtime is not initialized")
        }

        const output = this._deepFilterBindings.df_process_frame(this._deepFilterState, this._inputFrame)
        if (output.length !== this._algorithmFrameLength) {
            throw new Error(
                `DeepFilterNet returned invalid frame size. expected=${this._algorithmFrameLength}, actual=${output.length}`,
            )
        }

        this._outputFrame.set(output)
    }

    private _readEnabledFlag(): boolean {
        if (!this._sharedControl) {
            return this._shouldDenoise
        }

        return Atomics.load(this._sharedControl, CONTROL_ENABLED_INDEX) === 1
    }

    private _resetQueues() {
        const queueCapacity = 64 * Math.max(this._algorithmFrameLength, this._processBlockLength)
        this._processInputBlock = new Float32Array(this._processBlockLength)
        this._processOutputBlock = new Float32Array(this._processBlockLength)
        this._inputFrame = new Float32Array(this._algorithmFrameLength)
        this._outputFrame = new Float32Array(this._algorithmFrameLength)
        this._inputQueue = new MonoRingBuffer(queueCapacity)
        this._outputQueue = new MonoRingBuffer(queueCapacity)
    }

    private _resolveSampleRate(sampleRateValue?: number): number {
        if (!Number.isFinite(sampleRateValue) || (sampleRateValue ?? 0) <= 0) {
            return REQUIRED_SAMPLE_RATE
        }
        return sampleRateValue ?? REQUIRED_SAMPLE_RATE
    }

    private _resolveVadLogIntervalMs(value?: number): number {
        if (!Number.isFinite(value) || (value ?? 0) <= 0) {
            return DEFAULT_VAD_LOG_INTERVAL_MS
        }
        return value ?? DEFAULT_VAD_LOG_INTERVAL_MS
    }

    private _resolveEngine(engineValue?: DenoiserEngine): DenoiserEngine {
        if (engineValue === "deepfilternet") {
            return "deepfilternet"
        }
        return "rnnoise"
    }

    private _resolveDeepFilterOptions(options?: DeepFilterOptions): ResolvedDeepFilterOptions {
        const modelUrl =
            typeof options?.modelUrl === "string" && options.modelUrl.trim().length > 0
                ? options.modelUrl
                : undefined

        return {
            modelUrl,
            attenLimDb: this._resolveDeepFilterAttenLimDb(options?.attenLimDb),
            postFilterBeta: this._resolveDeepFilterPostFilterBeta(options?.postFilterBeta),
        }
    }

    private _resolveDeepFilterAttenLimDb(value?: number): number {
        if (!Number.isFinite(value)) {
            return DEFAULT_DF_ATTEN_LIM_DB
        }
        return Math.abs(value ?? DEFAULT_DF_ATTEN_LIM_DB)
    }

    private _resolveDeepFilterPostFilterBeta(value?: number): number {
        if (!Number.isFinite(value)) {
            return DEFAULT_DF_POST_FILTER_BETA
        }
        return Math.max(0, value ?? DEFAULT_DF_POST_FILTER_BETA)
    }

    private _maybeEmitVadLog(vadScore: number) {
        if (!this._debugLogs || !this._vadLogs) {
            return
        }

        const nowMs = this._nowMs()
        if (nowMs - this._lastVadLogAtMs < this._vadLogIntervalMs) {
            return
        }

        this._lastVadLogAtMs = nowMs
        this._global.postMessage({
            message: "DENOISER_WORKER_VAD",
            vadScore,
            intervalMs: this._vadLogIntervalMs,
        })
    }

    private _releaseRnnoiseRuntime() {
        if (this._rnContext && this._rnWasmInterface) {
            this._rnWasmInterface._rnnoise_destroy(this._rnContext)
            this._rnContext = 0
        }

        if (this._rnInputPtr && this._rnWasmInterface) {
            this._rnWasmInterface._free(this._rnInputPtr)
            this._rnInputPtr = 0
        }

        if (this._rnOutputPtr && this._rnWasmInterface) {
            this._rnWasmInterface._free(this._rnOutputPtr)
            this._rnOutputPtr = 0
        }

        this._rnInputHeap = undefined
        this._rnOutputHeap = undefined
        this._rnWasmInterface = undefined
    }

    private _releaseDeepFilterRuntime() {
        if (this._deepFilterState && this._deepFilterBindings) {
            this._deepFilterBindings.df_destroy(this._deepFilterState)
            this._deepFilterState = 0
        }
    }

    private _releaseRuntime(closeSharedState: boolean) {
        this._initialized = false
        this._loopRunning = false
        this._lastVadLogAtMs = 0

        if (this._sharedControl) {
            Atomics.store(this._sharedControl, CONTROL_WORKER_READY_INDEX, 0)
            Atomics.add(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)
            Atomics.notify(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)
        }

        this._releaseRnnoiseRuntime()
        this._releaseDeepFilterRuntime()

        this._inputQueue.clear()
        this._outputQueue.clear()
        this._algorithmFrameLength = RNNOISE_FRAME

        if (closeSharedState) {
            this._sharedInput = undefined
            this._sharedOutput = undefined
            this._sharedControl = undefined
        }
    }

    destroy() {
        this._destroyRequested = true

        if (this._sharedControl) {
            Atomics.store(this._sharedControl, CONTROL_DESTROY_INDEX, 1)
            Atomics.add(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)
            Atomics.notify(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)
        }

        this._releaseRuntime(true)
    }

    private _reportError(error: unknown) {
        this._global.postMessage({
            message: "DENOISER_WORKER_ERROR",
            error: error instanceof Error ? error.message : String(error),
        })
    }

    private _nowMs(): number {
        if (globalThis.performance && typeof globalThis.performance.now === "function") {
            return globalThis.performance.now()
        }
        return Date.now()
    }
}

const workerGlobal = globalThis as unknown as WorkerGlobalLike
const runtime = new DenoiserWorkerRuntime(workerGlobal)

workerGlobal.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
    runtime.handleMainMessage(event.data)
}
