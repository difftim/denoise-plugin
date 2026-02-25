import { Track } from "livekit-client"
import type { AudioProcessorOptions, Room, TrackProcessor } from "livekit-client"
import type {
    AudioPipelineOptions,
    DeepFilterModuleConfig,
    DenoiseModuleId,
    PipelineStage,
    RnnoiseModuleConfig,
} from "./options"
import type {
    MainToWorkletMessage,
    RuntimeMessage,
    WorkletDeepFilterConfigPayload,
    WorkletRnnoiseConfigPayload,
} from "./shared/contracts"
import { COMMAND_TIMEOUT_MS } from "./shared/contracts"
import {
    cloneArrayBuffer,
    mergeDeepFilterConfig,
    mergeRnnoiseConfig,
    normalizeAudioPipelineOptions,
    resolveDenoiseModule,
    type ResolvedAudioPipelineOptions,
    type ResolvedDeepFilterModuleConfig,
} from "./shared/normalize"

export interface PendingCommand {
    command: string
    timeoutId: ReturnType<typeof setTimeout>
    resolve: () => void
    reject: (error: Error) => void
}

export class AudioPipelineTrackProcessor implements TrackProcessor<
    Track.Kind.Audio,
    AudioProcessorOptions
> {
    private static readonly loadedContexts = new WeakSet<BaseAudioContext>()
    private static readonly loadedWorkletUrls = new WeakMap<BaseAudioContext, string>()

    readonly name = "audio-pipeline-filter"
    processedTrack?: MediaStreamTrack | undefined

    private audioOpts?: AudioProcessorOptions | undefined
    private denoiseNode?: AudioWorkletNode | undefined
    private orgSourceNode?: MediaStreamAudioSourceNode | undefined

    private enabled = true

    private _options: ResolvedAudioPipelineOptions

    private _nextRequestId = 1
    private _pendingCommands = new Map<number, PendingCommand>()
    private _operationQueue: Promise<void> = Promise.resolve()

    private readonly _handleRuntimeMessage = (event: MessageEvent<RuntimeMessage>) => {
        const payload = event.data
        if (!payload?.message) {
            return
        }

        if (payload.message === "COMMAND_OK") {
            this._resolveCommand(payload.requestId)
            return
        }

        if (payload.message === "COMMAND_ERROR") {
            this._rejectCommand(payload)
            return
        }

        if (this._options.debugLogs) {
            console.log(`[AudioPipelineRuntime][Worklet][${payload.message}]`)
        }
    }

    constructor(options: AudioPipelineOptions) {
        this._options = normalizeAudioPipelineOptions(options)
    }

    static isSupported(): boolean {
        return true
    }

    async init(opts: AudioProcessorOptions): Promise<void> {
        if (this._options.debugLogs) {
            console.log("AudioPipelineTrackProcessor.init", opts)
        }

        await this._initInternal(opts, false)
    }

    async restart(opts: AudioProcessorOptions): Promise<void> {
        opts.audioContext = opts.audioContext ?? this.audioOpts?.audioContext

        if (this._options.debugLogs) {
            console.log("AudioPipelineTrackProcessor.restart", opts)
        }

        await this._initInternal(opts, true)
    }

    async onPublish(room: Room): Promise<void> {
        if (this._options.debugLogs) {
            console.log("AudioPipelineTrackProcessor.onPublish", room.name)
        }
    }

    async onUnpublish(): Promise<void> {
        if (this._options.debugLogs) {
            console.log("AudioPipelineTrackProcessor.onUnpublish")
        }
    }

    async setEnabled(enable: boolean): Promise<void> {
        return this._runSerial(async () => {
            if (this._options.debugLogs) {
                console.log("AudioPipelineTrackProcessor.setEnabled", enable)
            }

            this.enabled = enable

            if (this.denoiseNode) {
                await this._sendCommand({
                    message: "SET_ENABLED",
                    enable,
                })
            }
        })
    }

    async setStageModule(stage: PipelineStage, moduleId: DenoiseModuleId): Promise<void> {
        return this._runSerial(async () => {
            if (stage !== "denoise") {
                throw new Error(`Unsupported stage: ${stage}`)
            }

            const nextModuleId = resolveDenoiseModule(moduleId)
            if (this._options.stages.denoise === nextModuleId) {
                return
            }

            let configPayload: WorkletRnnoiseConfigPayload | WorkletDeepFilterConfigPayload
            let transferables: Transferable[] | undefined

            if (nextModuleId === "deepfilternet") {
                const deepConfig = this._options.moduleConfigs.deepfilternet
                const modelBuffer = await this._resolveDeepFilterModelBuffer(deepConfig)
                configPayload = {
                    attenLimDb: deepConfig.attenLimDb,
                    postFilterBeta: deepConfig.postFilterBeta,
                    modelBuffer,
                }
                transferables = modelBuffer ? [modelBuffer] : undefined

                if (modelBuffer) {
                    this._options.moduleConfigs.deepfilternet.modelBuffer =
                        cloneArrayBuffer(modelBuffer)
                }
            } else {
                configPayload = {
                    ...this._options.moduleConfigs.rnnoise,
                }
            }

            if (this.denoiseNode) {
                await this._sendCommand(
                    {
                        message: "SET_STAGE_MODULE",
                        stage: "denoise",
                        moduleId: nextModuleId,
                        config: configPayload,
                    },
                    transferables,
                )
            }

            this._options.stages.denoise = nextModuleId
        })
    }

    async setModuleConfig(moduleId: "rnnoise", config: RnnoiseModuleConfig): Promise<void>
    async setModuleConfig(moduleId: "deepfilternet", config: DeepFilterModuleConfig): Promise<void>
    async setModuleConfig(
        moduleId: DenoiseModuleId,
        config: RnnoiseModuleConfig | DeepFilterModuleConfig,
    ): Promise<void> {
        return this._runSerial(async () => {
            if (moduleId === "rnnoise") {
                await this._setRnnoiseConfig(config as RnnoiseModuleConfig)
                return
            }

            await this._setDeepFilterConfig(config as DeepFilterModuleConfig)
        })
    }

    async isEnabled(): Promise<boolean> {
        return Boolean(this.denoiseNode && this.enabled)
    }

    async destroy(): Promise<void> {
        if (this._options.debugLogs) {
            console.log("AudioPipelineTrackProcessor.destroy")
        }

        this._closeInternal()
    }

    private async _setRnnoiseConfig(config: RnnoiseModuleConfig): Promise<void> {
        const nextConfig = mergeRnnoiseConfig(this._options.moduleConfigs.rnnoise, config)

        if (this.denoiseNode) {
            await this._sendCommand({
                message: "SET_MODULE_CONFIG",
                moduleId: "rnnoise",
                config: {
                    ...nextConfig,
                },
            })
        }

        this._options.moduleConfigs.rnnoise = nextConfig
    }

    private async _setDeepFilterConfig(config: DeepFilterModuleConfig): Promise<void> {
        const nextConfig = mergeDeepFilterConfig(this._options.moduleConfigs.deepfilternet, config)

        let modelBuffer: ArrayBuffer | undefined
        let clearModel = false

        if (config.modelBuffer !== undefined) {
            if (config.modelBuffer.byteLength <= 0) {
                throw new Error("DeepFilter modelBuffer is empty")
            }

            modelBuffer = cloneArrayBuffer(config.modelBuffer)
            nextConfig.modelBuffer = cloneArrayBuffer(modelBuffer)
        } else if (config.modelUrl !== undefined) {
            if (nextConfig.modelUrl) {
                modelBuffer = await this._fetchDeepFilterModel(nextConfig.modelUrl)
                nextConfig.modelBuffer = cloneArrayBuffer(modelBuffer)
            } else {
                clearModel = true
                nextConfig.modelBuffer = undefined
            }
        } else if (config.clearModel === true) {
            clearModel = true
            nextConfig.modelBuffer = undefined
        }

        if (this.denoiseNode) {
            const payload: WorkletDeepFilterConfigPayload = {
                attenLimDb: nextConfig.attenLimDb,
                postFilterBeta: nextConfig.postFilterBeta,
                modelBuffer,
                clearModel,
            }

            await this._sendCommand(
                {
                    message: "SET_MODULE_CONFIG",
                    moduleId: "deepfilternet",
                    config: payload,
                },
                modelBuffer ? [modelBuffer] : undefined,
            )
        }

        this._options.moduleConfigs.deepfilternet = nextConfig
    }

    private async _initInternal(opts: AudioProcessorOptions, restart: boolean): Promise<void> {
        if (!opts || !opts.audioContext || !opts.track) {
            throw new Error("audioContext and track are required")
        }

        if (restart) {
            this._closeInternal()
        }

        this.audioOpts = opts
        const ctx = this.audioOpts.audioContext

        const workletUrl = this._options.workletUrl
        if (!workletUrl) {
            throw new Error(
                "workletUrl is required. Pass AudioPipelineTrackProcessor({ workletUrl }).",
            )
        }

        let resolvedWorkletUrl = AudioPipelineTrackProcessor.loadedWorkletUrls.get(ctx)

        if (!AudioPipelineTrackProcessor.loadedContexts.has(ctx)) {
            if (this._options.debugLogs) {
                console.log("AudioPipelineWorkletURL:", workletUrl)
            }

            try {
                await ctx.audioWorklet.addModule(workletUrl)
                AudioPipelineTrackProcessor.loadedContexts.add(ctx)
                AudioPipelineTrackProcessor.loadedWorkletUrls.set(ctx, workletUrl)
                resolvedWorkletUrl = workletUrl
            } catch (error) {
                throw new Error(
                    `Failed to load audio pipeline worklet module: ${String(error)}. URL: ${workletUrl}`,
                )
            }
        } else if (!resolvedWorkletUrl) {
            resolvedWorkletUrl = workletUrl
            AudioPipelineTrackProcessor.loadedWorkletUrls.set(ctx, workletUrl)
        }

        if (this._options.debugLogs) {
            console.log("AudioPipelineWorkletResolvedURL:", resolvedWorkletUrl)
        }

        this.denoiseNode = new AudioWorkletNode(ctx, "AudioPipelineWorklet", {
            processorOptions: {
                debugLogs: this._options.debugLogs,
                numberOfChannels: this.audioOpts.track.getSettings().channelCount,
            },
        })
        this.denoiseNode.port.onmessage = this._handleRuntimeMessage

        const currentDenoiseModule = this._options.stages.denoise
        const rnnoisePayload: WorkletRnnoiseConfigPayload = {
            ...this._options.moduleConfigs.rnnoise,
        }

        const deepFilterConfig = this._options.moduleConfigs.deepfilternet
        let initModelBuffer: ArrayBuffer | undefined
        if (currentDenoiseModule === "deepfilternet") {
            initModelBuffer = await this._resolveDeepFilterModelBuffer(deepFilterConfig)
            if (initModelBuffer) {
                this._options.moduleConfigs.deepfilternet.modelBuffer =
                    cloneArrayBuffer(initModelBuffer)
            }
        }

        await this._sendCommand(
            {
                message: "INIT_PIPELINE",
                sampleRate: ctx.sampleRate,
                enable: this.enabled,
                debugLogs: this._options.debugLogs,
                stages: {
                    denoise: currentDenoiseModule,
                },
                moduleConfigs: {
                    rnnoise: rnnoisePayload,
                    deepfilternet: {
                        attenLimDb: deepFilterConfig.attenLimDb,
                        postFilterBeta: deepFilterConfig.postFilterBeta,
                        modelBuffer: initModelBuffer,
                    },
                },
            },
            initModelBuffer ? [initModelBuffer] : undefined,
        )

        this.orgSourceNode = ctx.createMediaStreamSource(new MediaStream([this.audioOpts.track]))
        this.orgSourceNode.connect(this.denoiseNode)

        const destination = ctx.createMediaStreamDestination()
        this.denoiseNode.connect(destination)

        this.processedTrack = destination.stream.getAudioTracks()[0]

        if (this._options.debugLogs) {
            console.log(
                `AudioPipelineTrackProcessor.init: sourceID: ${this.audioOpts.track.id}, newTrackID: ${this.processedTrack.id}`,
            )
        }
    }

    private async _resolveDeepFilterModelBuffer(
        config: ResolvedDeepFilterModuleConfig,
    ): Promise<ArrayBuffer | undefined> {
        if (config.modelBuffer) {
            return cloneArrayBuffer(config.modelBuffer)
        }

        if (!config.modelUrl) {
            return undefined
        }

        return this._fetchDeepFilterModel(config.modelUrl)
    }

    private _runSerial<T>(operation: () => Promise<T>): Promise<T> {
        const scheduled = this._operationQueue.then(operation, operation)
        this._operationQueue = scheduled.then(
            () => undefined,
            () => undefined,
        )
        return scheduled
    }

    private async _sendCommand(
        message: MainToWorkletMessage,
        transferables?: Transferable[],
    ): Promise<void> {
        if (!this.denoiseNode) {
            throw new Error("Audio pipeline worklet is not initialized")
        }

        const requestId = this._nextRequestId
        this._nextRequestId += 1

        await new Promise<void>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this._pendingCommands.delete(requestId)
                reject(
                    new Error(`Command timeout after ${COMMAND_TIMEOUT_MS}ms: ${message.message}`),
                )
            }, COMMAND_TIMEOUT_MS)

            this._pendingCommands.set(requestId, {
                command: message.message,
                timeoutId,
                resolve,
                reject,
            })

            try {
                this.denoiseNode?.port.postMessage(
                    {
                        ...message,
                        requestId,
                    },
                    transferables ?? [],
                )
            } catch (error) {
                clearTimeout(timeoutId)
                this._pendingCommands.delete(requestId)
                reject(error instanceof Error ? error : new Error(String(error)))
            }
        })
    }

    private _resolveCommand(requestId?: number) {
        if (requestId === undefined) {
            return
        }

        const pending = this._pendingCommands.get(requestId)
        if (!pending) {
            return
        }

        clearTimeout(pending.timeoutId)
        this._pendingCommands.delete(requestId)
        pending.resolve()
    }

    private _rejectCommand(payload: RuntimeMessage) {
        const requestId = payload.requestId
        const errorMessage =
            payload.error ?? `Runtime command failed: ${payload.command ?? "unknown"}`

        if (requestId === undefined) {
            if (this._options.debugLogs) {
                console.error(`[AudioPipelineRuntime][Worklet][COMMAND_ERROR] ${errorMessage}`)
            }
            return
        }

        const pending = this._pendingCommands.get(requestId)
        if (!pending) {
            if (this._options.debugLogs) {
                console.error(`[AudioPipelineRuntime][Worklet][COMMAND_ERROR] ${errorMessage}`)
            }
            return
        }

        clearTimeout(pending.timeoutId)
        this._pendingCommands.delete(requestId)
        pending.reject(new Error(errorMessage))
    }

    private _rejectAllPendingCommands(reason: string) {
        for (const pending of this._pendingCommands.values()) {
            clearTimeout(pending.timeoutId)
            pending.reject(new Error(reason))
        }

        this._pendingCommands.clear()
    }

    private async _fetchDeepFilterModel(modelUrl: string): Promise<ArrayBuffer> {
        const response = await fetch(modelUrl)
        if (!response.ok) {
            throw new Error(
                `Failed to fetch DeepFilter model: ${response.status} ${response.statusText}`,
            )
        }

        return response.arrayBuffer()
    }

    private _closeInternal() {
        if (this.denoiseNode) {
            try {
                this.denoiseNode.port.postMessage({ message: "DESTROY" })
            } catch (_error) {
                // Ignore postMessage errors when closing.
            }
            this.denoiseNode.port.onmessage = null
        }

        this._rejectAllPendingCommands("Audio pipeline runtime closed")

        this.denoiseNode?.disconnect()
        this.orgSourceNode?.disconnect()

        this.denoiseNode = undefined
        this.orgSourceNode = undefined
        this.processedTrack = undefined
    }
}
