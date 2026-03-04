import type { DenoiseModuleId } from "./options"
import type {
    MainToWorkletMessage,
    WorkletDeepFilterConfigPayload,
    WorkletRnnoiseConfigPayload,
    WorkletToMainMessage,
} from "./shared/contracts"
import { resolveDenoiseModule } from "./shared/normalize"
import { MonoRingBuffer } from "./worklet/MonoRingBuffer"
import { BufferPool } from "./shared/BufferPool"
import type { WorkerToWorkletMessage, WorkletToWorkerMessage } from "./shared/worker-contracts"

const QUANTUM_SAMPLES = 128
const DEFAULT_FRAME_LENGTH = 480
const FRAMES_PER_TRANSFER = 1

class AudioPipelineWorklet extends AudioWorkletProcessor {
    private _messageChain: Promise<void> = Promise.resolve()

    private _debugLogs = false
    private _destroyed = false
    private _shouldProcess = true
    private _workerReady = false

    private _currentModuleId: DenoiseModuleId = "rnnoise"
    private _frameLength = DEFAULT_FRAME_LENGTH
    private _transferSize = DEFAULT_FRAME_LENGTH * FRAMES_PER_TRANSFER
    private _prefilled = false

    private _workerPort?: MessagePort

    private _inputQueue = new MonoRingBuffer(64 * DEFAULT_FRAME_LENGTH)
    private _outputQueue = new MonoRingBuffer(64 * DEFAULT_FRAME_LENGTH)
    private _inputPool = new BufferPool(DEFAULT_FRAME_LENGTH * FRAMES_PER_TRANSFER, 8)

    private _lastVadScore: number | undefined
    private _lastVadLogAtMs = 0
    private _vadLogIntervalMs = 1000

    constructor(options: { processorOptions?: { debugLogs?: boolean } }) {
        super()
        this._debugLogs = options.processorOptions?.debugLogs ?? false
        this._setupMessageHandler()
        this._logInfo("AUDIO_PIPELINE_WORKLET_INIT")
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        if (this._destroyed) return false

        const inputMono = inputs[0]?.[0]
        const outputMono = outputs[0]?.[0]
        if (!inputMono || !outputMono) return true

        this._inputQueue.push(inputMono)

        const workerActive = this._workerReady && this._workerPort

        while (this._inputQueue.framesAvailable >= this._transferSize) {
            const frame = this._inputPool.acquire()
            this._inputQueue.pull(frame)

            if (workerActive) {
                this._workerPort!.postMessage(
                    { type: "PROCESS_FRAME", inputBuffer: frame } satisfies WorkletToWorkerMessage,
                    [frame.buffer],
                )
            } else {
                this._outputQueue.push(frame)
            }
        }

        this._outputQueue.pull(outputMono)
        const output = outputs[0]
        for (let ch = 1; ch < output.length; ch++) {
            output[ch].set(outputMono)
        }

        return true
    }

    // ── Main thread message handling ────────────────────────────────

    private _setupMessageHandler(): void {
        this.port.onmessage = (event: MessageEvent<MainToWorkletMessage>) => {
            const payload = event.data
            this._messageChain = this._messageChain
                .then(() => this._dispatch(payload))
                .catch((error) => {
                    this._respondError(payload?.requestId, payload?.message ?? "UNKNOWN", error)
                })
        }
    }

    private async _dispatch(payload: MainToWorkletMessage): Promise<void> {
        if (!payload?.message) return

        switch (payload.message) {
            case "INIT_PIPELINE":
                this._initPipeline(payload)
                break
            case "SET_ENABLED":
                this._setEnabled(payload.enable)
                break
            case "SET_STAGE_MODULE":
                this._handleSetStageModule(payload)
                break
            case "SET_MODULE_CONFIG":
                this._handleSetModuleConfig(payload)
                break
            case "DESTROY":
                this._destroy()
                break
            default:
                throw new Error(
                    `Unknown command: ${String((payload as { message: string }).message)}`,
                )
        }

        this._respondOk(payload.requestId, payload.message)
    }

    // ── Pipeline lifecycle ──────────────────────────────────────────

    private _initPipeline(
        payload: Extract<MainToWorkletMessage, { message: "INIT_PIPELINE" }>,
    ): void {
        this._debugLogs = payload.debugLogs ?? this._debugLogs
        this._currentModuleId = resolveDenoiseModule(payload.stages?.denoise)
        this._shouldProcess = payload.enable ?? this._shouldProcess

        if (payload.moduleConfigs?.rnnoise?.bufferOverflowMs) {
            this._vadLogIntervalMs = payload.moduleConfigs.rnnoise.bufferOverflowMs
        }

        if (payload.workerPort) {
            this._workerPort = payload.workerPort
            this._setupWorkerPort()

            const frameLength = payload.frameLength ?? DEFAULT_FRAME_LENGTH
            this._onWorkerInitOk(frameLength)
        }

        this._logInfo(`AUDIO_PIPELINE_WORKLET_READY:${this._currentModuleId}`)
    }

    private _setupWorkerPort(): void {
        if (!this._workerPort) return

        this._workerPort.onmessage = (event: MessageEvent<WorkerToWorkletMessage>) => {
            const msg = event.data
            if (!msg?.type) return

            switch (msg.type) {
                case "INIT_OK":
                    this._onWorkerInitOk(msg.frameLength)
                    break
                case "FRAME_RESULT":
                    this._onFrameResult(msg.outputBuffer, msg.vadScore)
                    break
                case "MODULE_CHANGED":
                    this._onModuleChanged(msg.frameLength, msg.lookahead)
                    break
                case "ERROR":
                    this._logError(`WORKER_ERROR:${msg.error}`)
                    break
            }
        }
    }

    private _onWorkerInitOk(frameLength: number): void {
        this._frameLength = frameLength
        this._rebuildForFrameLength(frameLength)
        this._workerReady = true
        this._logInfo("WORKER_INIT_OK", { frameLength })
    }

    private _onFrameResult(outputBuffer: Float32Array, vadScore?: number): void {
        this._outputQueue.push(outputBuffer)
        this._maybeEmitVadLog(vadScore)
    }

    private _onModuleChanged(frameLength: number, _lookahead: number): void {
        if (frameLength !== this._frameLength) {
            this._frameLength = frameLength
            this._rebuildForFrameLength(frameLength)
        }
        this._logInfo("MODULE_CHANGED", { frameLength })
    }

    private _rebuildForFrameLength(frameLength: number): void {
        this._transferSize = frameLength * FRAMES_PER_TRANSFER
        const queueCapacity = 64 * Math.max(this._transferSize, QUANTUM_SAMPLES)

        const prevInput = this._inputQueue
        const prevOutput = this._outputQueue

        this._inputQueue = new MonoRingBuffer(queueCapacity)
        this._outputQueue = new MonoRingBuffer(queueCapacity)

        prevInput.drainInto(this._inputQueue)
        prevOutput.drainInto(this._outputQueue)

        if (!this._prefilled) {
            this._prefilled = true
            const prefill = Math.ceil((2 * frameLength) / QUANTUM_SAMPLES) * QUANTUM_SAMPLES
            this._outputQueue.push(new Float32Array(prefill))
            this._logInfo("PREFILL", {
                frameLength,
                prefill,
                framesPerTransfer: FRAMES_PER_TRANSFER,
            })
        }

        this._inputPool = this._inputPool.resize(this._transferSize)

        this._logInfo("REBUILD_QUEUES", {
            frameLength,
            transferSize: this._transferSize,
            queueCapacity,
        })
    }

    private _setEnabled(enable: boolean): void {
        this._shouldProcess = enable
        this._lastVadLogAtMs = 0

        this._workerPort?.postMessage({
            type: "SET_ENABLED",
            enable,
        } satisfies WorkletToWorkerMessage)

        this._logInfo(enable ? "AUDIO_PIPELINE_ENABLED" : "AUDIO_PIPELINE_DISABLED")
    }

    private _handleSetStageModule(
        payload: Extract<MainToWorkletMessage, { message: "SET_STAGE_MODULE" }>,
    ): void {
        if (payload.stage !== "denoise") {
            throw new Error(`Unsupported stage: ${payload.stage}`)
        }

        const nextId = resolveDenoiseModule(payload.moduleId)
        this._currentModuleId = nextId

        this._workerPort?.postMessage({
            type: "SET_MODULE",
            moduleId: nextId,
            config: payload.config
                ? { [nextId === "rnnoise" ? "rnnoise" : "deepfilternet"]: payload.config }
                : undefined,
        } satisfies WorkletToWorkerMessage)
    }

    private _handleSetModuleConfig(
        payload: Extract<MainToWorkletMessage, { message: "SET_MODULE_CONFIG" }>,
    ): void {
        if (payload.moduleId === "rnnoise") {
            const rnConfig = payload.config as WorkletRnnoiseConfigPayload
            if (rnConfig?.bufferOverflowMs) {
                this._vadLogIntervalMs = rnConfig.bufferOverflowMs
            }
        }

        this._workerPort?.postMessage({
            type: "SET_CONFIG",
            moduleId: payload.moduleId,
            config: payload.config as Record<string, unknown>,
        } satisfies WorkletToWorkerMessage)
    }

    // ── Cleanup ─────────────────────────────────────────────────────

    private _destroy(): void {
        if (this._destroyed) return

        this._destroyed = true
        this._workerReady = false

        this._workerPort?.postMessage({ type: "DESTROY" } satisfies WorkletToWorkerMessage)
        this._workerPort?.close()
        this._workerPort = undefined

        this._inputQueue.clear()
        this._outputQueue.clear()

        this._logInfo("AUDIO_PIPELINE_WORKLET_DESTROYED")
    }

    // ── Messaging to main thread ────────────────────────────────────

    private _respondOk(requestId: number | undefined, command: string): void {
        if (requestId === undefined) return

        const payload: WorkletToMainMessage = { message: "COMMAND_OK", requestId, command }
        this.port.postMessage(payload)
    }

    private _respondError(requestId: number | undefined, command: string, error: unknown): void {
        const errorMsg = error instanceof Error ? error.message : String(error)
        const payload: WorkletToMainMessage = {
            message: "COMMAND_ERROR",
            requestId,
            command,
            error: errorMsg,
        }

        this.port.postMessage(payload)
        this._logError(`${command}:${errorMsg}`)
    }

    // ── VAD ─────────────────────────────────────────────────────────

    private _maybeEmitVadLog(vadScore: number | undefined): void {
        if (!this._debugLogs || this._currentModuleId !== "rnnoise") return
        if (!Number.isFinite(vadScore)) return

        this._lastVadScore = vadScore

        const nowMs = this._nowMs()
        if (nowMs - this._lastVadLogAtMs < this._vadLogIntervalMs) return

        this._lastVadLogAtMs = nowMs
        this._logInfo("AUDIO_PIPELINE_RNNOISE_VAD", {
            vadScore: this._lastVadScore,
            intervalMs: this._vadLogIntervalMs,
        })
    }

    // ── Logging ─────────────────────────────────────────────────────

    private _nowMs(): number {
        return typeof globalThis.performance?.now === "function"
            ? globalThis.performance.now()
            : Date.now()
    }

    private static readonly _LOG_TAG = "[AudioPipeline:Worklet]"

    private _logInfo(message: string, data?: unknown, forceLog = false): void {
        if (!forceLog && !this._debugLogs) return

        if (data !== undefined) {
            console.log(`${AudioPipelineWorklet._LOG_TAG} ${message}`, data)
        } else {
            console.log(`${AudioPipelineWorklet._LOG_TAG} ${message}`)
        }
    }

    private _logError(message: string, data?: unknown): void {
        if (data !== undefined) {
            console.error(`${AudioPipelineWorklet._LOG_TAG} ${message}`, data)
        } else {
            console.error(`${AudioPipelineWorklet._LOG_TAG} ${message}`)
        }
    }
}

registerProcessor("AudioPipelineWorklet", AudioPipelineWorklet)
