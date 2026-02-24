import createRNNWasmModuleSync from "./dist/rnnoise-sync.js"
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

interface IRnnoiseModule extends EmscriptenModule {
    _malloc: (size: number) => number
    _free: (pointer: number) => void
    _rnnoise_create: () => number
    _rnnoise_destroy: (context: number) => void
    _rnnoise_process_frame: (context: number, output: number, input: number) => number
}

interface MainToWorkerMessage {
    message: string
    sampleRate?: number
    enable?: boolean
    sharedBuffers?: SharedBufferPayload
    error?: string
}

interface WorkerGlobalLike {
    onmessage: ((event: MessageEvent<MainToWorkerMessage>) => void) | null
    postMessage: (message: unknown, transfer?: Transferable[]) => void
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

    private _initialized = false
    private _shouldDenoise = true
    private _sampleRate = REQUIRED_SAMPLE_RATE
    private _destroyRequested = false
    private _loopRunning = false
    private _lastSignalValue = 0

    private _sharedInput?: SharedRingBufferView
    private _sharedOutput?: SharedRingBufferView
    private _sharedControl?: Int32Array

    private _rnWasmInterface?: IRnnoiseModule
    private _rnContext = 0
    private _rnInputPtr = 0
    private _rnOutputPtr = 0
    private _rnInputHeap?: Float32Array
    private _rnOutputHeap?: Float32Array

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
                this._init(payload)
                break
            }
            case "SET_ENABLED": {
                this._setEnabled(payload.enable ?? this._shouldDenoise)
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

        Atomics.store(this._sharedControl, CONTROL_WORKER_READY_INDEX, 1)
        Atomics.add(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)
        Atomics.notify(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)

        this._resetQueues()
        clearSharedRing(this._sharedInput)
        clearSharedRing(this._sharedOutput)
    }

    private _init(payload: MainToWorkerMessage) {
        if (this._initialized) {
            this._releaseRuntime(false)
        }

        if (!this._sharedInput || !this._sharedOutput || !this._sharedControl) {
            throw new Error("Shared buffers are not attached")
        }

        this._sampleRate = this._resolveSampleRate(payload.sampleRate)

        if (this._sampleRate !== REQUIRED_SAMPLE_RATE) {
            throw new Error(
                `Unsupported sampleRate ${this._sampleRate}. RNNoise worker currently requires ${REQUIRED_SAMPLE_RATE}.`,
            )
        }

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

        this._destroyRequested = false
        this._resetQueues()
        this._initialized = true
        this._setEnabled(this._readEnabledFlag())
        this._startLoop()
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
                this._inputQueue.framesAvailable >= RNNOISE_FRAME &&
                this._inputQueue.pullMono(this._inputFrame)
            ) {
                this._processRnnoiseFrame()
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

        this._rnWasmInterface._rnnoise_process_frame(
            this._rnContext,
            this._rnOutputPtr,
            this._rnInputPtr,
        )

        for (let i = 0; i < RNNOISE_FRAME; i += 1) {
            this._outputFrame[i] = this._rnOutputHeap[i] / RNNOISE_SCALE
        }
    }

    private _readEnabledFlag(): boolean {
        if (!this._sharedControl) {
            return this._shouldDenoise
        }

        return Atomics.load(this._sharedControl, CONTROL_ENABLED_INDEX) === 1
    }

    private _resetQueues() {
        const queueCapacity = 64 * Math.max(RNNOISE_FRAME, this._processBlockLength)
        this._processInputBlock = new Float32Array(this._processBlockLength)
        this._processOutputBlock = new Float32Array(this._processBlockLength)
        this._inputFrame = new Float32Array(RNNOISE_FRAME)
        this._outputFrame = new Float32Array(RNNOISE_FRAME)
        this._inputQueue = new MonoRingBuffer(queueCapacity)
        this._outputQueue = new MonoRingBuffer(queueCapacity)
    }

    private _resolveSampleRate(sampleRateValue?: number): number {
        if (!Number.isFinite(sampleRateValue) || (sampleRateValue ?? 0) <= 0) {
            return REQUIRED_SAMPLE_RATE
        }
        return sampleRateValue ?? REQUIRED_SAMPLE_RATE
    }

    private _releaseRuntime(closeSharedState: boolean) {
        this._initialized = false
        this._loopRunning = false

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

        this._inputQueue.clear()
        this._outputQueue.clear()

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
}

const workerGlobal = globalThis as unknown as WorkerGlobalLike
const runtime = new DenoiserWorkerRuntime(workerGlobal)

workerGlobal.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
    try {
        runtime.handleMainMessage(event.data)
    } catch (error) {
        workerGlobal.postMessage({
            message: "DENOISER_WORKER_ERROR",
            error: error instanceof Error ? error.message : String(error),
        })
        runtime.destroy()
    }
}
