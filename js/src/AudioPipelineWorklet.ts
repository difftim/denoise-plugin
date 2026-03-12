import type { DenoiseModuleId } from "./options"
import type {
    LogMessage,
    MainToWorkletMessage,
    WorkletToMainMessage,
} from "./shared/contracts"
import { resolveDenoiseModule } from "./shared/normalize"
import { collectTransferBuffers } from "./shared/transfer"
import { Float32ArrayPool } from "./worklet/Float32ArrayPool"
import { MonoRingBuffer } from "./worklet/MonoRingBuffer"
import type { WorkerToWorkletMessage, WorkletToWorkerMessage } from "./shared/worker-contracts"

const QUANTUM_SAMPLES = 128
const DEFAULT_FRAME_LENGTH = 480
const DEFAULT_VAD_LOG_INTERVAL_MS = 1000
const DEFAULT_BATCH_FRAMES = 1

class AudioPipelineWorklet extends AudioWorkletProcessor {
    private _messageChain: Promise<void> = Promise.resolve()

    private _debugLogs = false
    private _destroyed = false
    private _workerReady = false

    private _currentModuleId: DenoiseModuleId = "rnnoise"
    private _frameLength = DEFAULT_FRAME_LENGTH
    private _batchFrames = DEFAULT_BATCH_FRAMES
    private _prefilled = false

    private _workerPort?: MessagePort

    private _framePool = new Float32ArrayPool(DEFAULT_FRAME_LENGTH)
    private _pendingRecycles: Float32Array[] = []
    private _batchQueue: Float32Array[] = []
    private _inputQueue = new MonoRingBuffer(64 * DEFAULT_FRAME_LENGTH)
    private _outputQueue = new MonoRingBuffer(64 * DEFAULT_FRAME_LENGTH)

    private _lastVadScore: number | undefined
    private _lastVadLogAtMs = 0
    private _vadLogIntervalMs = DEFAULT_VAD_LOG_INTERVAL_MS
    private _vadLogsEnabled = false

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

        for (let o = 0; o < outputs.length; o++) {
            const output = outputs[o]
            for (let ch = 0; ch < output.length; ch++) {
                output[ch].fill(0)
            }
        }
        this._inputQueue.push(inputMono)

        const workerActive = this._workerReady && this._workerPort

        while (this._inputQueue.framesAvailable >= this._frameLength) {
            const frame = this._framePool.acquire()
            this._inputQueue.pull(frame)

            if (workerActive) {
                this._batchQueue.push(frame)
            } else {
                this._outputQueue.push(frame)
                this._framePool.release(frame)
            }
        }

        if (workerActive && this._batchQueue.length >= this._batchFrames) {
            this._sendBatch()
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
                    this._respondError(payload?.requestId, payload?.type ?? "UNKNOWN", error)
                })
        }
    }

    private async _dispatch(payload: MainToWorkletMessage): Promise<void> {
        if (!payload?.type) return

        const t0 = this._nowMs()
        const commandType = payload.type

        switch (commandType) {
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
        }

        this._logInfo(`${commandType} dispatch`, {
            elapsed: `${(this._nowMs() - t0).toFixed(2)}ms`,
        })
        this._respondOk(payload.requestId, commandType)
    }

    // ── Pipeline lifecycle ──────────────────────────────────────────

    private _initPipeline(
        payload: Extract<MainToWorkletMessage, { type: "INIT_PIPELINE" }>,
    ): void {
        this._debugLogs = payload.debugLogs ?? this._debugLogs
        this._currentModuleId = resolveDenoiseModule(payload.stages?.denoise)
        this._batchFrames = Math.max(1, payload.batchFrames ?? DEFAULT_BATCH_FRAMES)

        this._vadLogIntervalMs =
            payload.moduleConfigs?.rnnoise?.vadLogIntervalMs ?? DEFAULT_VAD_LOG_INTERVAL_MS
        this._vadLogsEnabled = payload.moduleConfigs?.rnnoise?.vadLogs ?? false

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
                case "FRAME_RESULT_BATCH":
                    this._onFrameResultBatch(msg.outputBuffers, msg.vadScores, msg.recycleBuffers)
                    break
                case "MODULE_CHANGED":
                    this._onModuleChanged(msg.frameLength, msg.lookahead)
                    break
                case "ERROR":
                    this._logError(`WORKER_ERROR:${msg.error}`)
                    break
                case "LOG":
                    this._forwardLog(msg.level, msg.tag, msg.text, msg.data)
                    break
            }
        }
    }

    private _onWorkerInitOk(frameLength: number): void {
        this._frameLength = frameLength
        this._framePool.resize(frameLength)
        this._rebuildForFrameLength(frameLength)
        this._workerReady = true
        this._logInfo("WORKER_INIT_OK", { frameLength })
    }

    private _sendBatch(): void {
        const inputBuffers = this._batchQueue.splice(0)
        const recycles = this._pendingRecycles.length > 0
            ? this._pendingRecycles.splice(0)
            : undefined

        this._workerPort!.postMessage(
            {
                type: "PROCESS_FRAME_BATCH",
                inputBuffers,
                recycleBuffers: recycles,
            } satisfies WorkletToWorkerMessage,
            collectTransferBuffers(inputBuffers, recycles),
        )
    }

    private _onFrameResultBatch(
        outputBuffers: Float32Array[],
        vadScores: (number | undefined)[] | undefined,
        recycleBuffers: Float32Array[] | undefined,
    ): void {
        for (let i = 0; i < outputBuffers.length; i++) {
            this._outputQueue.push(outputBuffers[i])
            this._pendingRecycles.push(outputBuffers[i])
        }

        if (recycleBuffers) {
            for (let i = 0; i < recycleBuffers.length; i++) {
                this._framePool.release(recycleBuffers[i])
            }
        }

        if (vadScores) {
            const last = vadScores[vadScores.length - 1]
            this._maybeEmitVadLog(last)
        }
    }

    private _onModuleChanged(frameLength: number, _lookahead: number): void {
        if (frameLength !== this._frameLength) {
            this._frameLength = frameLength
            this._framePool.resize(frameLength)
            this._rebuildForFrameLength(frameLength)
        }
        this._logInfo("MODULE_CHANGED", { frameLength })
    }

    private _rebuildForFrameLength(frameLength: number): void {
        const queueCapacity = 128 * Math.max(frameLength, QUANTUM_SAMPLES)

        const prevInput = this._inputQueue
        const prevOutput = this._outputQueue

        this._inputQueue = new MonoRingBuffer(queueCapacity)
        this._outputQueue = new MonoRingBuffer(queueCapacity)

        prevInput.drainInto(this._inputQueue)
        prevOutput.drainInto(this._outputQueue)

        if (!this._prefilled) {
            this._prefilled = true
            const batchCollectQuanta = Math.ceil((this._batchFrames * frameLength) / QUANTUM_SAMPLES)
            const roundTripQuanta = Math.ceil(2 * this._batchFrames)
            const prefill = (batchCollectQuanta + roundTripQuanta) * QUANTUM_SAMPLES
            this._outputQueue.push(new Float32Array(prefill).fill(0))
            this._logInfo("PREFILL", { frameLength, batchFrames: this._batchFrames, prefill })
        }

        this._logInfo("REBUILD_QUEUES", { frameLength, queueCapacity })
    }

    private _setEnabled(enable: boolean): void {
        this._lastVadLogAtMs = 0

        this._workerPort?.postMessage({
            type: "SET_ENABLED",
            enable,
        } satisfies WorkletToWorkerMessage)

        this._logInfo(enable ? "AUDIO_PIPELINE_ENABLED" : "AUDIO_PIPELINE_DISABLED")
    }

    private _handleSetStageModule(
        payload: Extract<MainToWorkletMessage, { type: "SET_STAGE_MODULE" }>,
    ): void {
        if (payload.stage !== "denoise") {
            throw new Error(`Unsupported stage: ${payload.stage}`)
        }

        const nextId = resolveDenoiseModule(payload.moduleId)
        this._logInfo("MODULE_SWITCH_START", { from: this._currentModuleId, to: nextId })
        this._currentModuleId = nextId

        this._workerPort?.postMessage({
            type: "SET_MODULE",
            moduleId: nextId,
        } satisfies WorkletToWorkerMessage)
    }

    private _handleSetModuleConfig(
        payload: Extract<MainToWorkletMessage, { type: "SET_MODULE_CONFIG" }>,
    ): void {
        if (payload.moduleId === "rnnoise") {
            if (payload.config.vadLogIntervalMs !== undefined) {
                this._vadLogIntervalMs = payload.config.vadLogIntervalMs
            }

            this._workerPort?.postMessage({
                type: "SET_MODULE_CONFIG",
                moduleId: "rnnoise",
                config: payload.config,
            } satisfies WorkletToWorkerMessage)
            return
        }

        this._workerPort?.postMessage({
            type: "SET_MODULE_CONFIG",
            moduleId: "deepfilternet",
            config: payload.config,
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

        const payload: WorkletToMainMessage = { type: "COMMAND_OK", requestId, command }
        this.port.postMessage(payload)
    }

    private _respondError(requestId: number | undefined, command: string, error: unknown): void {
        const errorMsg = error instanceof Error ? error.message : String(error)
        const payload: WorkletToMainMessage = {
            type: "COMMAND_ERROR",
            requestId,
            command,
            error: errorMsg,
        }

        this.port.postMessage(payload)
        this._logError(`${command}:${errorMsg}`)
    }

    // ── VAD ─────────────────────────────────────────────────────────

    private _maybeEmitVadLog(vadScore: number | undefined): void {
        if (!this._debugLogs || this._currentModuleId !== "rnnoise" || !this._vadLogsEnabled) return
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

    private _postLog(level: "info" | "error", tag: string, text: string, data?: unknown): void {
        const payload: LogMessage = { type: "LOG", level, tag, text, data }
        try {
            this.port.postMessage(payload)
        } catch {
            // port may be closed during teardown
        }
    }

    private _forwardLog(level: "info" | "error", tag: string, text: string, data?: unknown): void {
        this._postLog(level, tag, text, data)
    }

    private _logInfo(message: string, data?: unknown, forceLog = false): void {
        if (!forceLog && !this._debugLogs) return
        this._postLog("info", AudioPipelineWorklet._LOG_TAG, message, data)
    }

    private _logError(message: string, data?: unknown): void {
        this._postLog("error", AudioPipelineWorklet._LOG_TAG, message, data)
    }
}

registerProcessor("AudioPipelineWorklet", AudioPipelineWorklet)
