import {
    ConverterType,
    create as createSampleRateConverter,
} from "@alexanderolsen/libsamplerate-js"
import type { DenoiseModuleId } from "./options"
import {
    type MainToWorkletMessage,
    type WorkletDeepFilterConfigPayload,
    type WorkletRnnoiseConfigPayload,
    type WorkletToMainMessage,
    REQUIRED_SAMPLE_RATE,
} from "./shared/contracts"
import {
    DEFAULT_DENOISE_MODULE,
    DEFAULT_DF_ATTEN_LIM_DB,
    DEFAULT_DF_POST_FILTER_BETA,
    normalizeModelUrl,
    mergeRnnoiseConfig,
    normalizeRnnoiseConfig,
    resolveDeepFilterAttenLimDb,
    resolveDeepFilterPostFilterBeta,
    resolveDenoiseModule,
} from "./shared/normalize"
import { DeepFilterModule, type DeepFilterRuntimeConfig } from "./worklet/modules/DeepFilterModule"
import { RnnoiseModule } from "./worklet/modules/RnnoiseModule"

const QUANTUM_SAMPLES = 128
const RESAMPLER_CONVERTER_TYPE = ConverterType.SRC_SINC_FASTEST
const RESAMPLER_OUTPUT_FRAME_PADDING = 32
const EMPTY_FLOAT32 = new Float32Array(0)

type ActiveDenoiseModule = RnnoiseModule | DeepFilterModule
type SampleRateConverter = Awaited<ReturnType<typeof createSampleRateConverter>>

type PipelineStages = {
    denoise: DenoiseModuleId
}

interface ResolvedDeepFilterRuntimeConfig extends DeepFilterRuntimeConfig {
    modelUrl?: string
}

interface WorkletModuleConfigState {
    rnnoise: {
        vadLogs: boolean
        bufferOverflowMs: number
    }
    deepfilternet: ResolvedDeepFilterRuntimeConfig
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

class AudioPipelineWorklet extends AudioWorkletProcessor {
    private _messageChain: Promise<void> = Promise.resolve()

    private _stageOrder: readonly string[] = ["denoise", "voice", "post"]

    private _debugLogs = false
    private _destroyed = false
    private _initialized = false
    private _shouldProcess = true
    private _processingErrorReported = false

    private _sampleRate = REQUIRED_SAMPLE_RATE
    private _resamplingEnabled = false
    private _resamplerInputSampleRate = REQUIRED_SAMPLE_RATE
    private _inputResampler?: SampleRateConverter
    private _outputResampler?: SampleRateConverter
    private _inputResampleBuffer = new Float32Array(0)
    private _outputResampleBuffer = new Float32Array(0)
    private _inputResampleOutLength = { frames: 0 }
    private _outputResampleOutLength = { frames: 0 }

    private _stages: PipelineStages = {
        denoise: DEFAULT_DENOISE_MODULE,
    }

    private _moduleConfigs: WorkletModuleConfigState = {
        rnnoise: normalizeRnnoiseConfig(),
        deepfilternet: {
            modelUrl: undefined,
            modelBytes: undefined,
            attenLimDb: DEFAULT_DF_ATTEN_LIM_DB,
            postFilterBeta: DEFAULT_DF_POST_FILTER_BETA,
        },
    }

    private _denoiseModule?: ActiveDenoiseModule

    private _lastVadLogAtMs = 0

    private _inputQueue = new MonoRingBuffer(64 * QUANTUM_SAMPLES)
    private _outputQueue = new MonoRingBuffer(64 * QUANTUM_SAMPLES)
    private _inputFrame = new Float32Array(QUANTUM_SAMPLES)
    private _outputFrame = new Float32Array(QUANTUM_SAMPLES)

    constructor(options: { processorOptions?: { debugLogs?: boolean } }) {
        super()

        this._debugLogs = options.processorOptions?.debugLogs ?? false
        this._handleControlMessages()

        this._logInfo("AUDIO_PIPELINE_WORKLET_INIT")
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        try {
            if (this._destroyed) {
                return false
            }

            const input = inputs[0]
            const output = outputs[0]
            const inputMono = input?.[0]
            const outputMono = output?.[0]

            if (!inputMono || !outputMono) {
                return true
            }

            if (!this._initialized || !this._denoiseModule || !this._shouldProcess) {
                this._copyMonoToOutput(inputMono, output)
            } else {
                const inputForModule = this._resampleInputIfNeeded(inputMono)
                this._inputQueue.push(inputForModule)

                while (
                    this._denoiseModule &&
                    this._inputQueue.framesAvailable >= this._denoiseModule.frameLength &&
                    this._inputQueue.pullMono(this._inputFrame)
                ) {
                    const vadScore = this._denoiseModule.processFrame(
                        this._inputFrame,
                        this._outputFrame,
                    )
                    this._maybeEmitVadLog(vadScore)
                    const outputForPlayback = this._resampleOutputIfNeeded(this._outputFrame)
                    this._outputQueue.push(outputForPlayback)
                }

                if (this._outputQueue.pullMono(outputMono)) {
                    for (let channel = 1; channel < output.length; channel += 1) {
                        output[channel].set(outputMono)
                    }
                }
            }

            return true
        } catch (error) {
            this._reportProcessError(error)
            return true
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
            case "INIT_PIPELINE": {
                await this._initPipeline(payload)
                this._respondOk(payload.requestId, payload.message)
                break
            }
            case "SET_ENABLED": {
                this._setEnabled(payload.enable)
                this._respondOk(payload.requestId, payload.message)
                break
            }
            case "SET_STAGE_MODULE": {
                await this._setStageModule(payload)
                this._respondOk(payload.requestId, payload.message)
                break
            }
            case "SET_MODULE_CONFIG": {
                await this._setModuleConfig(payload)
                this._respondOk(payload.requestId, payload.message)
                break
            }
            case "DESTROY": {
                this.destroy()
                this._respondOk(payload.requestId, payload.message)
                break
            }
            default: {
                throw new Error(
                    `Unknown command: ${String((payload as { message: string }).message)}`,
                )
            }
        }
    }

    private async _initPipeline(
        payload: Extract<MainToWorkletMessage, { message: "INIT_PIPELINE" }>,
    ) {
        this._sampleRate = this._resolveSampleRate(payload.sampleRate)
        if (this._sampleRate !== REQUIRED_SAMPLE_RATE) {
            console.warn(
                `[AudioPipelineWorklet] sampleRate=${this._sampleRate}, expected=${REQUIRED_SAMPLE_RATE}. Continue without throwing.`,
            )
        }

        this._debugLogs = payload.debugLogs ?? this._debugLogs

        this._stages = {
            denoise: resolveDenoiseModule(payload.stages?.denoise),
        }

        this._moduleConfigs.rnnoise = mergeRnnoiseConfig(
            normalizeRnnoiseConfig(),
            payload.moduleConfigs?.rnnoise,
        )

        this._moduleConfigs.deepfilternet = this._mergeDeepFilterRuntimeConfig(
            {
                modelUrl: undefined,
                modelBytes: undefined,
                attenLimDb: DEFAULT_DF_ATTEN_LIM_DB,
                postFilterBeta: DEFAULT_DF_POST_FILTER_BETA,
            },
            payload.moduleConfigs?.deepfilternet,
        )

        const candidate = this._createDenoiseModule(this._stages.denoise)
        this._swapDenoiseModule(candidate, this._stages.denoise)
        await this._configureResampling(candidate.frameLength)

        this._setEnabled(payload.enable ?? this._shouldProcess)

        this._logInfo(`AUDIO_PIPELINE_WORKLET_READY:${this._stages.denoise}`)
    }

    private async _setStageModule(
        payload: Extract<MainToWorkletMessage, { message: "SET_STAGE_MODULE" }>,
    ): Promise<void> {
        if (payload.stage !== "denoise") {
            throw new Error(`Unsupported stage: ${payload.stage}`)
        }

        const nextModuleId = resolveDenoiseModule(payload.moduleId)

        if (nextModuleId === "rnnoise") {
            this._moduleConfigs.rnnoise = mergeRnnoiseConfig(
                this._moduleConfigs.rnnoise,
                payload.config as WorkletRnnoiseConfigPayload | undefined,
            )

            if (
                this._denoiseModule instanceof RnnoiseModule &&
                this._stages.denoise === "rnnoise"
            ) {
                this._logInfo("RNNOISE_UPDATE_CONFIG", this._moduleConfigs.rnnoise, true)
                this._denoiseModule.updateConfig(this._moduleConfigs.rnnoise)
                this._lastVadLogAtMs = 0
                this._resetFlowState()
                return
            }

            const candidate = this._createDenoiseModule("rnnoise")
            this._swapDenoiseModule(candidate, "rnnoise")
            await this._configureResampling(candidate.frameLength)
            return
        }

        this._moduleConfigs.deepfilternet = this._mergeDeepFilterRuntimeConfig(
            this._moduleConfigs.deepfilternet,
            payload.config as WorkletDeepFilterConfigPayload | undefined,
        )

        if (
            this._denoiseModule instanceof DeepFilterModule &&
            this._stages.denoise === "deepfilternet"
        ) {
            this._logInfo(
                "DEEPFILTERNET_UPDATE_CONFIG",
                this._summarizeDeepFilterConfig(this._moduleConfigs.deepfilternet),
                true,
            )
            this._denoiseModule.updateConfig(this._moduleConfigs.deepfilternet)
            this._resetFlowState()
            return
        }

        const candidate = this._createDenoiseModule("deepfilternet")
        this._swapDenoiseModule(candidate, "deepfilternet")
        await this._configureResampling(candidate.frameLength)
    }

    private async _setModuleConfig(
        payload: Extract<MainToWorkletMessage, { message: "SET_MODULE_CONFIG" }>,
    ): Promise<void> {
        if (payload.moduleId === "rnnoise") {
            this._moduleConfigs.rnnoise = mergeRnnoiseConfig(
                this._moduleConfigs.rnnoise,
                payload.config as WorkletRnnoiseConfigPayload,
            )

            if (
                this._denoiseModule instanceof RnnoiseModule &&
                this._stages.denoise === "rnnoise"
            ) {
                this._logInfo("RNNOISE_UPDATE_CONFIG", this._moduleConfigs.rnnoise, true)
                this._denoiseModule.updateConfig(this._moduleConfigs.rnnoise)
                this._lastVadLogAtMs = 0
            }
            return
        }

        this._moduleConfigs.deepfilternet = this._mergeDeepFilterRuntimeConfig(
            this._moduleConfigs.deepfilternet,
            payload.config as WorkletDeepFilterConfigPayload,
        )

        if (
            this._denoiseModule instanceof DeepFilterModule &&
            this._stages.denoise === "deepfilternet"
        ) {
            this._logInfo(
                "DEEPFILTERNET_UPDATE_CONFIG",
                this._summarizeDeepFilterConfig(this._moduleConfigs.deepfilternet),
                true,
            )
            this._denoiseModule.updateConfig(this._moduleConfigs.deepfilternet)
        }
    }

    private _createDenoiseModule(moduleId: DenoiseModuleId): ActiveDenoiseModule {
        if (moduleId === "deepfilternet") {
            return new DeepFilterModule(this._moduleConfigs.deepfilternet)
        }

        return new RnnoiseModule(this._moduleConfigs.rnnoise)
    }

    private _swapDenoiseModule(module: ActiveDenoiseModule, moduleId: DenoiseModuleId) {
        const previous = this._denoiseModule

        this._denoiseModule = module
        this._stages.denoise = moduleId
        this._initialized = true
        this._processingErrorReported = false
        this._lastVadLogAtMs = 0

        this._resetQueues(module.frameLength)
        previous?.dispose()

        this._logInfo(`AUDIO_PIPELINE_STAGE_ACTIVE:denoise=${moduleId}`)
    }

    private _setEnabled(enable: boolean) {
        this._shouldProcess = enable
        this._lastVadLogAtMs = 0
        this._resetFlowState()

        this._logInfo(enable ? "AUDIO_PIPELINE_ENABLED" : "AUDIO_PIPELINE_DISABLED")
    }

    private async _configureResampling(moduleFrameLength: number): Promise<void> {
        if (this._sampleRate === REQUIRED_SAMPLE_RATE) {
            const wasEnabled = this._resamplingEnabled
            this._destroyResamplers()
            this._resamplingEnabled = false

            if (wasEnabled) {
                this._logInfo(
                    "AUDIO_PIPELINE_RESAMPLING_DISABLED",
                    {
                        sampleRate: this._sampleRate,
                    },
                    true,
                )
            }

            return
        }

        const needCreate =
            !this._resamplingEnabled ||
            !this._inputResampler ||
            !this._outputResampler ||
            this._resamplerInputSampleRate !== this._sampleRate

        if (needCreate) {
            this._destroyResamplers()

            try {
                this._inputResampler = await createSampleRateConverter(
                    1,
                    this._sampleRate,
                    REQUIRED_SAMPLE_RATE,
                    {
                        converterType: RESAMPLER_CONVERTER_TYPE,
                    },
                )
                this._outputResampler = await createSampleRateConverter(
                    1,
                    REQUIRED_SAMPLE_RATE,
                    this._sampleRate,
                    {
                        converterType: RESAMPLER_CONVERTER_TYPE,
                    },
                )
            } catch (error) {
                this._destroyResamplers()
                this._resamplingEnabled = false
                throw new Error(
                    `Failed to initialize sample-rate converters: ${error instanceof Error ? error.message : String(error)}`,
                )
            }

            this._resamplingEnabled = true
            this._resamplerInputSampleRate = this._sampleRate
            this._logInfo(
                "AUDIO_PIPELINE_RESAMPLING_ENABLED",
                {
                    inputSampleRate: this._sampleRate,
                    processingSampleRate: REQUIRED_SAMPLE_RATE,
                },
                true,
            )
        }

        this._ensureInputResampleBuffer(QUANTUM_SAMPLES)
        this._ensureOutputResampleBuffer(moduleFrameLength)
    }

    private _destroyResamplers() {
        if (this._inputResampler) {
            this._inputResampler.destroy()
            this._inputResampler = undefined
        }

        if (this._outputResampler) {
            this._outputResampler.destroy()
            this._outputResampler = undefined
        }

        this._inputResampleBuffer = EMPTY_FLOAT32
        this._outputResampleBuffer = EMPTY_FLOAT32
        this._inputResampleOutLength.frames = 0
        this._outputResampleOutLength.frames = 0
        this._resamplingEnabled = false
        this._resamplerInputSampleRate = REQUIRED_SAMPLE_RATE
    }

    private _resampleInputIfNeeded(inputMono: Float32Array): Float32Array {
        if (!this._resamplingEnabled || !this._inputResampler) {
            return inputMono
        }

        this._ensureInputResampleBuffer(inputMono.length)
        this._inputResampleOutLength.frames = 0

        const resampled = this._inputResampler.full(
            inputMono,
            this._inputResampleBuffer,
            this._inputResampleOutLength,
        )
        const outputFrames = this._inputResampleOutLength.frames
        if (!Number.isFinite(outputFrames) || outputFrames <= 0) {
            return EMPTY_FLOAT32
        }

        return resampled.subarray(0, outputFrames)
    }

    private _resampleOutputIfNeeded(moduleOutput: Float32Array): Float32Array {
        if (!this._resamplingEnabled || !this._outputResampler) {
            return moduleOutput
        }

        this._ensureOutputResampleBuffer(moduleOutput.length)
        this._outputResampleOutLength.frames = 0

        const resampled = this._outputResampler.full(
            moduleOutput,
            this._outputResampleBuffer,
            this._outputResampleOutLength,
        )
        const outputFrames = this._outputResampleOutLength.frames
        if (!Number.isFinite(outputFrames) || outputFrames <= 0) {
            return EMPTY_FLOAT32
        }

        return resampled.subarray(0, outputFrames)
    }

    private _ensureInputResampleBuffer(inputFrames: number) {
        if (!this._resamplingEnabled) {
            return
        }

        const requiredFrames = this._estimateResampledFrames(
            inputFrames,
            this._sampleRate,
            REQUIRED_SAMPLE_RATE,
        )

        if (this._inputResampleBuffer.length < requiredFrames) {
            this._inputResampleBuffer = new Float32Array(requiredFrames)
        }
    }

    private _ensureOutputResampleBuffer(inputFrames: number) {
        if (!this._resamplingEnabled) {
            return
        }

        const requiredFrames = this._estimateResampledFrames(
            inputFrames,
            REQUIRED_SAMPLE_RATE,
            this._sampleRate,
        )

        if (this._outputResampleBuffer.length < requiredFrames) {
            this._outputResampleBuffer = new Float32Array(requiredFrames)
        }
    }

    private _estimateResampledFrames(
        inputFrames: number,
        fromSampleRate: number,
        toSampleRate: number,
    ): number {
        if (
            !Number.isFinite(inputFrames) ||
            inputFrames <= 0 ||
            !Number.isFinite(fromSampleRate) ||
            fromSampleRate <= 0 ||
            !Number.isFinite(toSampleRate) ||
            toSampleRate <= 0
        ) {
            return 0
        }

        if (fromSampleRate === toSampleRate) {
            return Math.ceil(inputFrames)
        }

        return (
            Math.ceil((inputFrames * toSampleRate) / fromSampleRate) +
            RESAMPLER_OUTPUT_FRAME_PADDING
        )
    }

    private _resolveSampleRate(sampleRateValue?: number): number {
        if (!Number.isFinite(sampleRateValue) || (sampleRateValue ?? 0) <= 0) {
            return REQUIRED_SAMPLE_RATE
        }

        return sampleRateValue ?? REQUIRED_SAMPLE_RATE
    }

    private _mergeDeepFilterRuntimeConfig(
        base: ResolvedDeepFilterRuntimeConfig,
        patch?: WorkletDeepFilterConfigPayload,
    ): ResolvedDeepFilterRuntimeConfig {
        let modelUrl = normalizeModelUrl(base.modelUrl)
        let modelBytes = base.modelBytes ? base.modelBytes.slice(0) : undefined

        if (patch?.clearModel === true) {
            modelUrl = undefined
            modelBytes = undefined
        }

        if (patch?.modelUrl !== undefined) {
            modelUrl = normalizeModelUrl(patch.modelUrl)
            modelBytes = undefined
        }

        if (patch?.modelBuffer !== undefined) {
            if (patch.modelBuffer.byteLength <= 0) {
                throw new Error("DeepFilter modelBuffer is empty")
            }
            modelBytes = new Uint8Array(patch.modelBuffer.slice(0))
        }

        return {
            modelUrl,
            modelBytes,
            attenLimDb:
                patch?.attenLimDb !== undefined
                    ? resolveDeepFilterAttenLimDb(patch.attenLimDb)
                    : base.attenLimDb,
            postFilterBeta:
                patch?.postFilterBeta !== undefined
                    ? resolveDeepFilterPostFilterBeta(patch.postFilterBeta)
                    : base.postFilterBeta,
        }
    }

    private _resetQueues(frameLength: number) {
        const inputResampledQuantum = this._estimateResampledFrames(
            QUANTUM_SAMPLES,
            this._sampleRate,
            REQUIRED_SAMPLE_RATE,
        )
        const outputResampledFrame = this._estimateResampledFrames(
            frameLength,
            REQUIRED_SAMPLE_RATE,
            this._sampleRate,
        )
        const queueCapacity =
            64 * Math.max(frameLength, QUANTUM_SAMPLES, inputResampledQuantum, outputResampledFrame)
        this._inputQueue = new MonoRingBuffer(queueCapacity)
        this._outputQueue = new MonoRingBuffer(queueCapacity)
        this._inputFrame = new Float32Array(frameLength)
        this._outputFrame = new Float32Array(frameLength)

        this._logInfo("AUDIO_PIPELINE_WORKLET_RESET_QUEUES", {
            frameLength,
            inputResampledQuantum,
            outputResampledFrame,
            queueCapacity,
        })
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

        this._denoiseModule?.dispose()
        this._denoiseModule = undefined
        this._destroyResamplers()
        this._resamplingEnabled = false
        this._resetQueues(QUANTUM_SAMPLES)
        this._resetFlowState()

        this._logInfo("AUDIO_PIPELINE_WORKLET_DESTROYED")
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

        this._logError(`${command}:${payload.error ?? "Unknown command error"}`)
    }

    private _maybeEmitVadLog(vadScore: number | undefined) {
        if (!this._debugLogs || this._stages.denoise !== "rnnoise") {
            return
        }

        if (!this._moduleConfigs.rnnoise.vadLogs || !Number.isFinite(vadScore)) {
            return
        }

        const nowMs = this._nowMs()
        if (nowMs - this._lastVadLogAtMs < this._moduleConfigs.rnnoise.bufferOverflowMs) {
            return
        }

        this._lastVadLogAtMs = nowMs
        this._logInfo("AUDIO_PIPELINE_RNNOISE_VAD", {
            vadScore,
            intervalMs: this._moduleConfigs.rnnoise.bufferOverflowMs,
        })
    }

    private _reportProcessError(error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error)

        this._denoiseModule?.dispose()
        this._denoiseModule = undefined
        this._destroyResamplers()
        this._resamplingEnabled = false
        this._initialized = false
        this._shouldProcess = false
        this._resetQueues(QUANTUM_SAMPLES)
        this._resetFlowState()

        if (!this._processingErrorReported) {
            this._processingErrorReported = true
            this._logError(`PROCESS_ERROR:${errorMessage}`)
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

    private _nowMs(): number {
        if (globalThis.performance && typeof globalThis.performance.now === "function") {
            return globalThis.performance.now()
        }

        return Date.now()
    }

    private _summarizeDeepFilterConfig(config: ResolvedDeepFilterRuntimeConfig): {
        attenLimDb: number
        postFilterBeta: number
        hasModelBytes: boolean
        modelBytesLength: number
        modelUrl?: string
    } {
        return {
            attenLimDb: config.attenLimDb,
            postFilterBeta: config.postFilterBeta,
            hasModelBytes: Boolean(config.modelBytes),
            modelBytesLength: config.modelBytes?.byteLength ?? 0,
            modelUrl: config.modelUrl,
        }
    }

    private _logInfo(message: string, data?: unknown, forceLog = false) {
        if (!forceLog && !this._debugLogs) {
            return
        }

        if (data !== undefined) {
            console.log(`[AudioPipelineWorklet] ${message}`, data)
            return
        }

        console.log(`[AudioPipelineWorklet] ${message}`)
    }

    private _logError(message: string, data?: unknown) {
        if (data !== undefined) {
            console.error(`[AudioPipelineWorklet] ${message}`, data)
            return
        }

        console.error(`[AudioPipelineWorklet] ${message}`)
    }
}

registerProcessor("AudioPipelineWorklet", AudioPipelineWorklet)
