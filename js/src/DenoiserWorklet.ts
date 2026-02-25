import createRNNWasmModuleSync from "./dist/rnnoise-sync.js"
import createDeepFilterWasmModuleSync from "./dist/deepfilter-sync.js"

const RNNOISE_FRAME = 480
const QUANTUM_SAMPLES = 128
const REQUIRED_SAMPLE_RATE = 48000
const RNNOISE_SCALE = 32768
const DEFAULT_VAD_LOG_INTERVAL_MS = 1000
const DEFAULT_DENOISER_ENGINE: DenoiserEngine = "rnnoise"
const DEFAULT_DF_ATTEN_LIM_DB = 100
const DEFAULT_DF_POST_FILTER_BETA = 0

type DenoiserEngine = "rnnoise" | "deepfilternet"

interface IRnnoiseModule extends EmscriptenModule {
    _malloc: (size: number) => number
    _free: (pointer: number) => void
    _rnnoise_create: () => number
    _rnnoise_destroy: (context: number) => void
    _rnnoise_process_frame: (context: number, output: number, input: number) => number
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

interface DeepFilterCommandPayload {
    modelBuffer?: ArrayBuffer
    clearModel?: boolean
    attenLimDb?: number
    postFilterBeta?: number
}

interface ResolvedDeepFilterOptions {
    modelBytes?: Uint8Array
    attenLimDb: number
    postFilterBeta: number
}

interface MainToWorkletMessage {
    message: string
    requestId?: number
    sampleRate?: number
    enable?: boolean
    debugLogs?: boolean
    vadLogs?: boolean
    bufferOverflowMs?: number
    engine?: DenoiserEngine
    deepFilter?: DeepFilterCommandPayload
}

interface WorkletToMainMessage {
    message: "COMMAND_OK" | "COMMAND_ERROR" | "RUNTIME_LOG"
    requestId?: number
    command?: string
    error?: string
    level?: "info" | "error"
    logMessage?: string
    vadScore?: number
    intervalMs?: number
}

interface RuntimeBackend {
    readonly engine: DenoiserEngine
    readonly frameLength: number
    processFrame(input: Float32Array, output: Float32Array): number | undefined
    applyDeepFilterParams(_attenLimDb: number, _postFilterBeta: number): void
    dispose(): void
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

        for (let index = 0; index < input.length; index += 1) {
            this._data[this._writeIndex] = input[index]
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

        for (let index = 0; index < target.length; index += 1) {
            target[index] = this._data[this._readIndex]
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

class RnnoiseBackend implements RuntimeBackend {
    readonly engine: DenoiserEngine = "rnnoise"
    readonly frameLength = RNNOISE_FRAME

    private readonly _module: IRnnoiseModule
    private readonly _context: number
    private readonly _inputPtr: number
    private readonly _outputPtr: number
    private readonly _inputHeap: Float32Array
    private readonly _outputHeap: Float32Array

    constructor() {
        this._module = createRNNWasmModuleSync() as IRnnoiseModule
        this._context = this._module._rnnoise_create()

        if (!this._context) {
            throw new Error("Failed to initialize RNNoise context")
        }

        this._inputPtr = this._module._malloc(RNNOISE_FRAME * Float32Array.BYTES_PER_ELEMENT)
        this._outputPtr = this._module._malloc(RNNOISE_FRAME * Float32Array.BYTES_PER_ELEMENT)

        if (!this._inputPtr || !this._outputPtr) {
            if (this._inputPtr) {
                this._module._free(this._inputPtr)
            }
            if (this._outputPtr) {
                this._module._free(this._outputPtr)
            }
            this._module._rnnoise_destroy(this._context)
            throw new Error("Failed to allocate RNNoise heap buffers")
        }

        const inputOffset = this._inputPtr >> 2
        const outputOffset = this._outputPtr >> 2
        this._inputHeap = this._module.HEAPF32.subarray(inputOffset, inputOffset + RNNOISE_FRAME)
        this._outputHeap = this._module.HEAPF32.subarray(outputOffset, outputOffset + RNNOISE_FRAME)
    }

    processFrame(input: Float32Array, output: Float32Array): number {
        for (let index = 0; index < RNNOISE_FRAME; index += 1) {
            this._inputHeap[index] = input[index] * RNNOISE_SCALE
        }

        const vadScore = this._module._rnnoise_process_frame(
            this._context,
            this._outputPtr,
            this._inputPtr,
        )

        for (let index = 0; index < RNNOISE_FRAME; index += 1) {
            output[index] = this._outputHeap[index] / RNNOISE_SCALE
        }

        return vadScore
    }

    applyDeepFilterParams(_attenLimDb: number, _postFilterBeta: number): void {
        // RNNoise backend does not support DeepFilter params.
    }

    dispose() {
        this._module._rnnoise_destroy(this._context)
        this._module._free(this._inputPtr)
        this._module._free(this._outputPtr)
    }
}

class DeepFilterBackend implements RuntimeBackend {
    readonly engine: DenoiserEngine = "deepfilternet"
    readonly frameLength: number

    private readonly _bindings: DeepFilterBindings
    private readonly _state: number

    constructor(options: ResolvedDeepFilterOptions) {
        this._bindings = createDeepFilterWasmModuleSync() as DeepFilterBindings

        if (options.modelBytes) {
            this._state = this._bindings.df_create(options.modelBytes, options.attenLimDb)
        } else {
            this._state = this._bindings.df_create_default(options.attenLimDb)
        }

        if (!this._state) {
            throw new Error("Failed to create DeepFilterNet state")
        }

        const frameLength = this._bindings.df_get_frame_length(this._state)
        if (!Number.isFinite(frameLength) || frameLength <= 0) {
            this._bindings.df_destroy(this._state)
            throw new Error(`Invalid DeepFilterNet frame length: ${frameLength}`)
        }

        this.frameLength = frameLength
        this.applyDeepFilterParams(options.attenLimDb, options.postFilterBeta)
    }

    processFrame(input: Float32Array, output: Float32Array): number | undefined {
        const processed = this._bindings.df_process_frame(this._state, input)
        if (processed.length !== this.frameLength) {
            throw new Error(
                `DeepFilterNet returned invalid frame size. expected=${this.frameLength}, actual=${processed.length}`,
            )
        }

        output.set(processed)
        return undefined
    }

    applyDeepFilterParams(attenLimDb: number, postFilterBeta: number): void {
        this._bindings.df_set_atten_lim(this._state, attenLimDb)
        this._bindings.df_set_post_filter_beta(this._state, postFilterBeta)
    }

    dispose() {
        this._bindings.df_destroy(this._state)
    }
}

class DenoiserWorklet extends AudioWorkletProcessor {
    private _messageChain: Promise<void> = Promise.resolve()

    private _debugLogs = false
    private _vadLogs = false
    private _vadLogIntervalMs = DEFAULT_VAD_LOG_INTERVAL_MS
    private _lastVadLogAtMs = 0

    private _destroyed = false
    private _initialized = false
    private _shouldDenoise = true
    private _processingErrorReported = false

    private _sampleRate = REQUIRED_SAMPLE_RATE
    private _engine: DenoiserEngine = DEFAULT_DENOISER_ENGINE
    private _runtime?: RuntimeBackend
    private _deepFilterOptions: ResolvedDeepFilterOptions = {
        attenLimDb: DEFAULT_DF_ATTEN_LIM_DB,
        postFilterBeta: DEFAULT_DF_POST_FILTER_BETA,
    }

    private _inputQueue = new MonoRingBuffer(64 * Math.max(RNNOISE_FRAME, QUANTUM_SAMPLES))
    private _outputQueue = new MonoRingBuffer(64 * Math.max(RNNOISE_FRAME, QUANTUM_SAMPLES))
    private _inputFrame = new Float32Array(RNNOISE_FRAME)
    private _outputFrame = new Float32Array(RNNOISE_FRAME)

    constructor(options: { processorOptions?: { debugLogs?: boolean } }) {
        super()

        this._debugLogs = options.processorOptions?.debugLogs ?? false
        this._handleControlMessages()
        if (this._debugLogs) {
            this._postRuntimeLog("info", "DENOISER_WORKLET_INIT")
        }
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        const processStartMs = this._nowMs()
        let inputFrames = 0
        let inputDurationMs = 0

        try {
            if (this._destroyed) {
                return false
            }

            const input = inputs[0]
            const output = outputs[0]
            const inputMono = input?.[0]
            const outputMono = output?.[0]

            inputFrames = inputMono?.length ?? 0
            inputDurationMs = this._framesToMs(inputFrames)

            if (!inputMono || !outputMono) {
                return true
            }

            if (!this._initialized || !this._runtime || !this._shouldDenoise) {
                this._copyMonoToOutput(inputMono, output)
                return true
            }

            this._inputQueue.push(inputMono)

            while (
                this._runtime &&
                this._inputQueue.framesAvailable >= this._runtime.frameLength &&
                this._inputQueue.pullMono(this._inputFrame)
            ) {
                const vadScore = this._runtime.processFrame(this._inputFrame, this._outputFrame)
                this._maybeEmitVadLog(vadScore)
                this._outputQueue.push(this._outputFrame)
            }

            const pulled = this._outputQueue.pullMono(outputMono)
            if (pulled) {
                for (let channel = 1; channel < output.length; channel += 1) {
                    output[channel].set(outputMono)
                }
            } else {
                this._copyMonoToOutput(inputMono, output)
            }

            return true
        } catch (error) {
            this._reportProcessError(error)
            this._copyMonoToOutput(inputs[0]?.[0] ?? new Float32Array(0), outputs[0] ?? [])
            return true
        } finally {
            this._maybeLogProcessOverrun(processStartMs, inputDurationMs, inputFrames)
        }
    }

    private _handleControlMessages() {
        this.port.onmessage = (event: MessageEvent<MainToWorkletMessage>) => {
            const payload = event.data

            this._messageChain = this._messageChain
                .then(async () => {
                    await this._handleMainMessage(payload)
                })
                .catch((error) => {
                    this._respondError(payload?.requestId, payload?.message ?? "UNKNOWN", error)
                })
        }
    }

    private async _handleMainMessage(payload: MainToWorkletMessage) {
        if (!payload?.message) {
            return
        }

        switch (payload.message) {
            case "INIT_RUNTIME": {
                await this._initRuntime(payload)
                this._respondOk(payload.requestId, payload.message)
                break
            }
            case "SET_ENABLED": {
                this._setEnabled(payload.enable ?? this._shouldDenoise)
                this._respondOk(payload.requestId, payload.message)
                break
            }
            case "SET_ENGINE": {
                await this._setEngine(payload.engine, payload.deepFilter)
                this._respondOk(payload.requestId, payload.message)
                break
            }
            case "SET_DEEPFILTER_PARAMS": {
                await this._setDeepFilterParams(payload.deepFilter)
                this._respondOk(payload.requestId, payload.message)
                break
            }
            case "SET_DEEPFILTER_CONFIG": {
                await this._setDeepFilterConfig(payload.deepFilter)
                this._respondOk(payload.requestId, payload.message)
                break
            }
            case "DESTROY":
            case "DESTORY": {
                this.destroy()
                this._respondOk(payload.requestId, payload.message)
                break
            }
            default: {
                throw new Error(`Unknown command: ${payload.message}`)
            }
        }
    }

    private async _initRuntime(payload: MainToWorkletMessage) {
        this._sampleRate = this._resolveSampleRate(payload.sampleRate)
        if (this._sampleRate !== REQUIRED_SAMPLE_RATE) {
            throw new Error(
                `Unsupported sampleRate ${this._sampleRate}. Worklet currently requires ${REQUIRED_SAMPLE_RATE}.`,
            )
        }

        this._debugLogs = payload.debugLogs ?? this._debugLogs
        this._vadLogs = payload.vadLogs ?? false
        this._vadLogIntervalMs = this._resolveVadLogIntervalMs(payload.bufferOverflowMs)
        this._lastVadLogAtMs = 0

        const nextEngine = this._resolveEngine(payload.engine)
        const nextDeepOptions = this._mergeDeepFilterOptions(payload.deepFilter)
        const candidate = await this._createRuntime(nextEngine, nextDeepOptions)
        this._swapRuntime(candidate, nextEngine, nextDeepOptions)

        this._setEnabled(payload.enable ?? this._shouldDenoise)

        if (this._debugLogs) {
            this._postRuntimeLog(
                "info",
                this._engine === "deepfilternet"
                    ? "DENOISER_WORKLET_DF_READY"
                    : "DENOISER_WORKLET_RN_READY",
            )
        }
    }

    private async _setEngine(
        engineValue?: DenoiserEngine,
        deepFilterPayload?: DeepFilterCommandPayload,
    ): Promise<void> {
        const nextEngine = this._resolveEngine(engineValue)
        const nextDeepOptions = this._mergeDeepFilterOptions(deepFilterPayload)

        if (this._runtime && this._engine === nextEngine) {
            this._deepFilterOptions = nextDeepOptions
            if (this._runtime instanceof DeepFilterBackend && nextEngine === "deepfilternet") {
                this._runtime.applyDeepFilterParams(
                    nextDeepOptions.attenLimDb,
                    nextDeepOptions.postFilterBeta,
                )
            }
            return
        }

        const candidate = await this._createRuntime(nextEngine, nextDeepOptions)
        this._swapRuntime(candidate, nextEngine, nextDeepOptions)

        if (this._debugLogs) {
            this._postRuntimeLog("info", `DENOISER_WORKLET_ENGINE_SWITCHED:${nextEngine}`)
        }
    }

    private async _setDeepFilterParams(payload?: DeepFilterCommandPayload): Promise<void> {
        if (!payload) {
            return
        }

        if (this._engine !== "deepfilternet") {
            if (this._debugLogs) {
                this._postRuntimeLog("info", "DENOISER_WORKLET_DF_PARAMS_IGNORED_ENGINE_RNNOISE")
            }
            return
        }

        const nextDeepOptions = this._mergeDeepFilterOptions(payload)
        const candidate = await this._createRuntime("deepfilternet", nextDeepOptions)
        this._swapRuntime(candidate, "deepfilternet", nextDeepOptions)

        if (this._debugLogs) {
            this._postRuntimeLog(
                "info",
                `DENOISER_WORKLET_DF_PARAMS_UPDATED:atten=${nextDeepOptions.attenLimDb},beta=${nextDeepOptions.postFilterBeta}`,
            )
        }
    }

    private async _setDeepFilterConfig(payload?: DeepFilterCommandPayload): Promise<void> {
        if (!payload) {
            return
        }

        if (this._engine !== "deepfilternet") {
            if (this._debugLogs) {
                this._postRuntimeLog("info", "DENOISER_WORKLET_DF_CONFIG_IGNORED_ENGINE_RNNOISE")
            }
            return
        }

        const nextDeepOptions = this._mergeDeepFilterOptions(payload)
        const shouldRecreateRuntime =
            payload.modelBuffer !== undefined || payload.clearModel === true || !this._runtime

        if (shouldRecreateRuntime) {
            const candidate = await this._createRuntime("deepfilternet", nextDeepOptions)
            this._swapRuntime(candidate, "deepfilternet", nextDeepOptions)
            return
        }

        this._deepFilterOptions = nextDeepOptions

        if (this._runtime instanceof DeepFilterBackend) {
            this._runtime.applyDeepFilterParams(
                nextDeepOptions.attenLimDb,
                nextDeepOptions.postFilterBeta,
            )
        }
    }

    private async _createRuntime(
        engine: DenoiserEngine,
        deepFilterOptions: ResolvedDeepFilterOptions,
    ): Promise<RuntimeBackend> {
        if (engine === "deepfilternet") {
            return new DeepFilterBackend(deepFilterOptions)
        }

        return new RnnoiseBackend()
    }

    private _swapRuntime(
        runtime: RuntimeBackend,
        engine: DenoiserEngine,
        deepFilterOptions: ResolvedDeepFilterOptions,
    ) {
        const previousRuntime = this._runtime

        this._runtime = runtime
        this._engine = engine
        this._deepFilterOptions = deepFilterOptions
        this._initialized = true
        this._processingErrorReported = false
        this._lastVadLogAtMs = 0
        this._resetQueues(runtime.frameLength)

        previousRuntime?.dispose()
    }

    private _setEnabled(enable: boolean) {
        this._shouldDenoise = enable
        this._lastVadLogAtMs = 0
        this._resetFlowState()

        if (this._debugLogs) {
            this._postRuntimeLog(
                "info",
                enable ? "DENOISER_WORKLET_ENABLED" : "DENOISER_WORKLET_DISABLED",
            )
        }
    }

    private _resetQueues(frameLength: number) {
        const queueCapacity = 64 * Math.max(frameLength, QUANTUM_SAMPLES)
        this._inputQueue = new MonoRingBuffer(queueCapacity)
        this._outputQueue = new MonoRingBuffer(queueCapacity)
        this._inputFrame = new Float32Array(frameLength)
        this._outputFrame = new Float32Array(frameLength)
    }

    private _resetFlowState() {
        this._inputQueue.clear()
        this._outputQueue.clear()
    }

    destroy() {
        if (this._destroyed) {
            return
        }

        this._destroyed = true
        this._initialized = false
        this._runtime?.dispose()
        this._runtime = undefined
        this._resetQueues(RNNOISE_FRAME)

        if (this._debugLogs) {
            this._postRuntimeLog("info", "DENOISER_WORKLET_DESTROYED")
        }
    }

    private _mergeDeepFilterOptions(payload?: DeepFilterCommandPayload): ResolvedDeepFilterOptions {
        const base = this._deepFilterOptions

        if (!payload) {
            return {
                modelBytes: base.modelBytes,
                attenLimDb: base.attenLimDb,
                postFilterBeta: base.postFilterBeta,
            }
        }

        let modelBytes = base.modelBytes

        if (payload.clearModel === true) {
            modelBytes = undefined
        } else if (payload.modelBuffer !== undefined) {
            if (payload.modelBuffer.byteLength <= 0) {
                throw new Error("DeepFilter modelBuffer is empty")
            }
            modelBytes = new Uint8Array(payload.modelBuffer.slice(0))
        }

        return {
            modelBytes,
            attenLimDb: this._resolveDeepFilterAttenLimDb(payload.attenLimDb ?? base.attenLimDb),
            postFilterBeta: this._resolveDeepFilterPostFilterBeta(
                payload.postFilterBeta ?? base.postFilterBeta,
            ),
        }
    }

    private _resolveSampleRate(sampleRateValue?: number): number {
        if (!Number.isFinite(sampleRateValue) || (sampleRateValue ?? 0) <= 0) {
            return REQUIRED_SAMPLE_RATE
        }
        return sampleRateValue ?? REQUIRED_SAMPLE_RATE
    }

    private _resolveEngine(engineValue?: DenoiserEngine): DenoiserEngine {
        if (engineValue === "deepfilternet") {
            return "deepfilternet"
        }
        return "rnnoise"
    }

    private _resolveVadLogIntervalMs(value?: number): number {
        if (!Number.isFinite(value) || (value ?? 0) <= 0) {
            return DEFAULT_VAD_LOG_INTERVAL_MS
        }
        return value ?? DEFAULT_VAD_LOG_INTERVAL_MS
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

    private _respondOk(requestId: number | undefined, command: string) {
        if (requestId === undefined) {
            return
        }

        const payload: WorkletToMainMessage = {
            message: "COMMAND_OK",
            requestId,
            command,
        }
        this.port.postMessage(payload)
    }

    private _respondError(requestId: number | undefined, command: string, error: unknown) {
        const payload: WorkletToMainMessage = {
            message: "COMMAND_ERROR",
            requestId,
            command,
            error: error instanceof Error ? error.message : String(error),
        }

        this.port.postMessage(payload)

        if (this._debugLogs) {
            this._postRuntimeLog("error", `${command}:${payload.error ?? "Unknown command error"}`)
        }
    }

    private _postRuntimeLog(level: "info" | "error", logMessage: string) {
        const payload: WorkletToMainMessage = {
            message: "RUNTIME_LOG",
            level,
            logMessage,
        }

        this.port.postMessage(payload)
    }

    private _maybeEmitVadLog(vadScore: number | undefined) {
        if (!this._debugLogs || !this._vadLogs || !Number.isFinite(vadScore)) {
            return
        }

        const nowMs = this._nowMs()
        if (nowMs - this._lastVadLogAtMs < this._vadLogIntervalMs) {
            return
        }

        this._lastVadLogAtMs = nowMs

        const payload: WorkletToMainMessage = {
            message: "RUNTIME_LOG",
            level: "info",
            logMessage: "DENOISER_WORKLET_VAD",
            vadScore,
            intervalMs: this._vadLogIntervalMs,
        }

        this.port.postMessage(payload)
    }

    private _reportProcessError(error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error)

        this._runtime?.dispose()
        this._runtime = undefined
        this._initialized = false
        this._shouldDenoise = false
        this._resetQueues(RNNOISE_FRAME)

        if (!this._processingErrorReported) {
            this._processingErrorReported = true
            this._postRuntimeLog("error", `PROCESS_ERROR:${errorMessage}`)
        }
    }

    private _copyMonoToOutput(input: Float32Array, output: Float32Array[]) {
        for (let index = 0; index < input.length; index += 1) {
            const value = input[index]
            for (let channel = 0; channel < output.length; channel += 1) {
                output[channel][index] = value
            }
        }
    }

    private _maybeLogProcessOverrun(
        processStartMs: number,
        inputDurationMs: number,
        inputFrames: number,
    ) {
        if (!this._debugLogs || !this._vadLogs || inputDurationMs <= 0) {
            return
        }

        const elapsedMs = this._nowMs() - processStartMs
        if (elapsedMs <= inputDurationMs) {
            return
        }

        console.warn(
            `[DenoiserWorklet][process] overrun elapsedMs=${elapsedMs.toFixed(3)} inputDurationMs=${inputDurationMs.toFixed(3)} inputFrames=${inputFrames}`,
        )
    }

    private _framesToMs(frames: number): number {
        if (!Number.isFinite(frames) || frames <= 0) {
            return 0
        }

        const sr =
            typeof sampleRate === "number" && Number.isFinite(sampleRate) && sampleRate > 0
                ? sampleRate
                : REQUIRED_SAMPLE_RATE

        return (frames / sr) * 1000
    }

    private _nowMs(): number {
        if (globalThis.performance && typeof globalThis.performance.now === "function") {
            return globalThis.performance.now()
        }
        return Date.now()
    }
}

registerProcessor("DenoiserWorklet", DenoiserWorklet)
