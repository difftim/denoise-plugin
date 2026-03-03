import type { DenoiseModuleId } from "./options"
import type {
    MainToWorkletMessage,
    WorkletDeepFilterConfigPayload,
    WorkletRnnoiseConfigPayload,
    WorkletToMainMessage,
} from "./shared/contracts"
import {
    DEFAULT_DENOISE_MODULE,
    cloneBytes,
    defaultWorkletDeepFilterState,
    mergeRnnoiseConfig,
    mergeWorkletDeepFilterState,
    normalizeRnnoiseConfig,
    resolveDenoiseModule,
    sameBytes,
    type ResolvedRnnoiseModuleConfig,
    type WorkletDeepFilterState,
} from "./shared/normalize"
import { MonoRingBuffer } from "./worklet/MonoRingBuffer"
import { DeepFilterModule } from "./worklet/modules/DeepFilterModule"
import { RnnoiseModule } from "./worklet/modules/RnnoiseModule"

const QUANTUM_SAMPLES = 128

type ActiveDenoiseModule = RnnoiseModule | DeepFilterModule

interface FrameProcessor {
    readonly frameLength: number
    processFrame(input: Float32Array, output: Float32Array): number | undefined
}

const passthroughProcessor: FrameProcessor = {
    frameLength: QUANTUM_SAMPLES,
    processFrame(input: Float32Array, output: Float32Array) {
        output.set(input)
        return undefined
    },
}

class AudioPipelineWorklet extends AudioWorkletProcessor {
    private _messageChain: Promise<void> = Promise.resolve()

    private _debugLogs = false
    private _destroyed = false
    private _initialized = false
    private _shouldProcess = true
    private _processingErrorReported = false

    private _currentModuleId: DenoiseModuleId = DEFAULT_DENOISE_MODULE

    private _rnnoiseConfig: ResolvedRnnoiseModuleConfig = normalizeRnnoiseConfig()
    private _deepFilterState: WorkletDeepFilterState = defaultWorkletDeepFilterState()

    private _denoiseModule?: ActiveDenoiseModule
    private _lastDfModelBytes?: Uint8Array

    private _activeProcessor: FrameProcessor = passthroughProcessor

    private _lastVadLogAtMs = 0

    private _inputQueue = new MonoRingBuffer(64 * QUANTUM_SAMPLES)
    private _outputQueue = new MonoRingBuffer(64 * QUANTUM_SAMPLES)
    private _inputFrame = new Float32Array(QUANTUM_SAMPLES)
    private _outputFrame = new Float32Array(QUANTUM_SAMPLES)

    constructor(options: { processorOptions?: { debugLogs?: boolean } }) {
        super()
        this._debugLogs = options.processorOptions?.debugLogs ?? false
        this._setupMessageHandler()
        this._logInfo("AUDIO_PIPELINE_WORKLET_INIT")
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        try {
            if (this._destroyed) return false

            const inputMono = inputs[0]?.[0]
            const outputMono = outputs[0]?.[0]
            if (!inputMono || !outputMono) return true

            const processor = this._activeProcessor
            this._inputQueue.push(inputMono)

            while (
                this._inputQueue.framesAvailable >= processor.frameLength &&
                this._inputQueue.pull(this._inputFrame)
            ) {
                const vadScore = processor.processFrame(this._inputFrame, this._outputFrame)
                this._maybeEmitVadLog(vadScore)
                this._outputQueue.push(this._outputFrame)
            }

            if (this._outputQueue.pull(outputMono)) {
                const output = outputs[0]
                for (let ch = 1; ch < output.length; ch += 1) {
                    output[ch].set(outputMono)
                }
            }

            return true
        } catch (error) {
            this._reportProcessError(error)
            return true
        }
    }

    // ── Message handling ───────────────────────────────────────────

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

    // ── Pipeline lifecycle ─────────────────────────────────────────

    private _initPipeline(
        payload: Extract<MainToWorkletMessage, { message: "INIT_PIPELINE" }>,
    ): void {
        this._debugLogs = payload.debugLogs ?? this._debugLogs
        this._currentModuleId = resolveDenoiseModule(payload.stages?.denoise)

        this._rnnoiseConfig = mergeRnnoiseConfig(
            normalizeRnnoiseConfig(),
            payload.moduleConfigs?.rnnoise,
        )
        this._deepFilterState = mergeWorkletDeepFilterState(
            defaultWorkletDeepFilterState(),
            payload.moduleConfigs?.deepfilternet,
        )

        this._swapDenoiseModule(
            this._createDenoiseModule(this._currentModuleId),
            this._currentModuleId,
        )

        this._shouldProcess = payload.enable ?? this._shouldProcess
        this._syncActiveProcessor()
        this._logInfo(`AUDIO_PIPELINE_WORKLET_READY:${this._currentModuleId}`)
    }

    private _setEnabled(enable: boolean): void {
        this._shouldProcess = enable
        this._lastVadLogAtMs = 0
        this._syncActiveProcessor()
        this._logInfo(enable ? "AUDIO_PIPELINE_ENABLED" : "AUDIO_PIPELINE_DISABLED")
    }

    private _handleSetStageModule(
        payload: Extract<MainToWorkletMessage, { message: "SET_STAGE_MODULE" }>,
    ): void {
        if (payload.stage !== "denoise") {
            throw new Error(`Unsupported stage: ${payload.stage}`)
        }

        const nextId = resolveDenoiseModule(payload.moduleId)

        if (nextId === "rnnoise") {
            this._rnnoiseConfig = mergeRnnoiseConfig(
                this._rnnoiseConfig,
                payload.config as WorkletRnnoiseConfigPayload | undefined,
            )

            if (
                this._denoiseModule instanceof RnnoiseModule &&
                this._currentModuleId === "rnnoise"
            ) {
                this._logInfo("RNNOISE_UPDATE_CONFIG", this._rnnoiseConfig, true)
                this._denoiseModule.updateConfig(this._rnnoiseConfig)
                this._lastVadLogAtMs = 0
                return
            }

            this._swapDenoiseModule(this._createDenoiseModule("rnnoise"), "rnnoise")
            return
        }

        this._deepFilterState = mergeWorkletDeepFilterState(
            this._deepFilterState,
            payload.config as WorkletDeepFilterConfigPayload | undefined,
        )

        if (
            this._denoiseModule instanceof DeepFilterModule &&
            this._currentModuleId === "deepfilternet"
        ) {
            this._applyDeepFilterUpdate()
            return
        }

        this._swapDenoiseModule(this._createDenoiseModule("deepfilternet"), "deepfilternet")
    }

    private _handleSetModuleConfig(
        payload: Extract<MainToWorkletMessage, { message: "SET_MODULE_CONFIG" }>,
    ): void {
        if (payload.moduleId === "rnnoise") {
            this._rnnoiseConfig = mergeRnnoiseConfig(
                this._rnnoiseConfig,
                payload.config as WorkletRnnoiseConfigPayload,
            )

            if (
                this._denoiseModule instanceof RnnoiseModule &&
                this._currentModuleId === "rnnoise"
            ) {
                this._logInfo("RNNOISE_UPDATE_CONFIG", this._rnnoiseConfig, true)
                this._denoiseModule.updateConfig(this._rnnoiseConfig)
                this._lastVadLogAtMs = 0
            }
            return
        }

        this._deepFilterState = mergeWorkletDeepFilterState(
            this._deepFilterState,
            payload.config as WorkletDeepFilterConfigPayload,
        )

        if (
            this._denoiseModule instanceof DeepFilterModule &&
            this._currentModuleId === "deepfilternet"
        ) {
            this._applyDeepFilterUpdate()
        }
    }

    // ── DeepFilter helpers ─────────────────────────────────────────

    private _applyDeepFilterUpdate(): void {
        const dfModule = this._denoiseModule as DeepFilterModule
        const state = this._deepFilterState

        this._logInfo("DEEPFILTERNET_UPDATE_CONFIG", this._summarizeDfConfig(state), true)

        const modelChanged = !sameBytes(this._lastDfModelBytes, state.modelBytes)
        dfModule.updateConfig(state)

        if (modelChanged) {
            this._lastDfModelBytes = cloneBytes(state.modelBytes)
            this._warmUpModule(dfModule)
        }
    }

    private _summarizeDfConfig(state: WorkletDeepFilterState) {
        return {
            attenLimDb: state.attenLimDb,
            postFilterBeta: state.postFilterBeta,
            hasModelBytes: Boolean(state.modelBytes),
            modelBytesLength: state.modelBytes?.byteLength ?? 0,
            modelUrl: state.modelUrl,
        }
    }

    // ── Module management ──────────────────────────────────────────

    private _createDenoiseModule(moduleId: DenoiseModuleId): ActiveDenoiseModule {
        if (moduleId === "deepfilternet") {
            return new DeepFilterModule(this._deepFilterState)
        }
        return new RnnoiseModule(this._rnnoiseConfig)
    }

    private _swapDenoiseModule(module: ActiveDenoiseModule, moduleId: DenoiseModuleId): void {
        const previous = this._denoiseModule

        this._denoiseModule = module
        this._currentModuleId = moduleId
        this._initialized = true
        this._processingErrorReported = false
        this._lastVadLogAtMs = 0

        if (module instanceof DeepFilterModule) {
            this._lastDfModelBytes = cloneBytes(this._deepFilterState.modelBytes)
        }

        this._rebuildQueues(module.frameLength)
        this._warmUpModule(module)
        this._syncActiveProcessor()
        previous?.dispose()

        this._logInfo(`AUDIO_PIPELINE_STAGE_ACTIVE:denoise=${moduleId}`)
    }

    private _syncActiveProcessor(): void {
        if (this._initialized && this._denoiseModule && this._shouldProcess) {
            this._activeProcessor = this._denoiseModule
        } else {
            this._activeProcessor = passthroughProcessor
        }
        this._ensureFrameBuffers(this._activeProcessor.frameLength)
    }

    private _rebuildQueues(frameLength: number): void {
        const queueCapacity = 64 * Math.max(frameLength, QUANTUM_SAMPLES)

        const prevInput = this._inputQueue
        const prevOutput = this._outputQueue

        this._inputQueue = new MonoRingBuffer(queueCapacity)
        this._outputQueue = new MonoRingBuffer(queueCapacity)

        prevInput.drainInto(this._inputQueue)
        prevOutput.drainInto(this._outputQueue)

        this._ensureFrameBuffers(frameLength)
        this._logInfo("AUDIO_PIPELINE_WORKLET_REBUILD_QUEUES", { frameLength, queueCapacity })
    }

    private _warmUpModule(module: ActiveDenoiseModule): void {
        if (!(module instanceof DeepFilterModule) || module.lookahead <= 0) return

        const frameLength = module.frameLength
        const lookahead = module.lookahead
        const silentInput = new Float32Array(frameLength)
        const discardOutput = new Float32Array(frameLength)

        for (let i = 0; i < lookahead; i++) {
            module.processFrame(silentInput, discardOutput)
        }

        this._logInfo("AUDIO_PIPELINE_WORKLET_WARMUP", { frameLength, lookahead })
    }

    private _ensureFrameBuffers(frameLength: number): void {
        if (this._inputFrame.length !== frameLength) {
            this._inputFrame = new Float32Array(frameLength)
        }
        if (this._outputFrame.length !== frameLength) {
            this._outputFrame = new Float32Array(frameLength)
        }
    }

    // ── Cleanup ────────────────────────────────────────────────────

    private _destroy(): void {
        if (this._destroyed) return

        this._destroyed = true
        this._initialized = false
        this._denoiseModule?.dispose()
        this._denoiseModule = undefined
        this._activeProcessor = passthroughProcessor
        this._inputQueue.clear()
        this._outputQueue.clear()

        this._logInfo("AUDIO_PIPELINE_WORKLET_DESTROYED")
    }

    private _reportProcessError(error: unknown): void {
        this._denoiseModule?.dispose()
        this._denoiseModule = undefined
        this._initialized = false
        this._shouldProcess = false
        this._activeProcessor = passthroughProcessor
        this._ensureFrameBuffers(QUANTUM_SAMPLES)

        if (!this._processingErrorReported) {
            this._processingErrorReported = true
            const msg = error instanceof Error ? error.message : String(error)
            this._logError(`PROCESS_ERROR:${msg}`)
        }
    }

    // ── Messaging ──────────────────────────────────────────────────

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

    // ── VAD ────────────────────────────────────────────────────────

    private _maybeEmitVadLog(vadScore: number | undefined): void {
        if (!this._debugLogs || this._currentModuleId !== "rnnoise") return
        if (!this._rnnoiseConfig.vadLogs || !Number.isFinite(vadScore)) return

        const nowMs = this._nowMs()
        if (nowMs - this._lastVadLogAtMs < this._rnnoiseConfig.bufferOverflowMs) return

        this._lastVadLogAtMs = nowMs
        this._logInfo("AUDIO_PIPELINE_RNNOISE_VAD", {
            vadScore,
            intervalMs: this._rnnoiseConfig.bufferOverflowMs,
        })
    }

    // ── Logging ────────────────────────────────────────────────────

    private _nowMs(): number {
        return typeof globalThis.performance?.now === "function"
            ? globalThis.performance.now()
            : Date.now()
    }

    private _logInfo(message: string, data?: unknown, forceLog = false): void {
        if (!forceLog && !this._debugLogs) return

        if (data !== undefined) {
            console.log(`[AudioPipelineWorklet] ${message}`, data)
        } else {
            console.log(`[AudioPipelineWorklet] ${message}`)
        }
    }

    private _logError(message: string, data?: unknown): void {
        if (data !== undefined) {
            console.error(`[AudioPipelineWorklet] ${message}`, data)
        } else {
            console.error(`[AudioPipelineWorklet] ${message}`)
        }
    }
}

registerProcessor("AudioPipelineWorklet", AudioPipelineWorklet)
