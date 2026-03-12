import { Track } from "livekit-client"
import type { AudioProcessorOptions, Room, TrackProcessor } from "livekit-client"
import type {
    AudioPipelineOptions,
    DeepFilterModuleConfig,
    DenoiseModuleId,
    PipelineStage,
    RnnoiseModuleConfig,
} from "./options"
import { COMMAND_TIMEOUT_MS } from "./shared/contracts"
import type {
    MainToWorkletMessage,
    RuntimeMessage,
    WorkletModuleConfigPayloadMap,
} from "./shared/contracts"
import { CommandTransport } from "./shared/command-transport"
import {
    mergeDeepFilterConfig,
    mergeRnnoiseConfig,
    normalizeAudioPipelineOptions,
    resolveDenoiseModule,
    type ResolvedAudioPipelineOptions,
} from "./shared/normalize"
import { fetchWasmBinaries } from "./shared/wasm-loader"
import type { WorkerToWorkletMessage, WorkletToWorkerMessage } from "./shared/worker-contracts"

export class AudioPipelineTrackProcessor implements TrackProcessor<
    Track.Kind.Audio,
    AudioProcessorOptions
> {
    private static readonly _loadedContexts = new WeakSet<BaseAudioContext>()

    readonly name = "audio-pipeline-filter"
    processedTrack?: MediaStreamTrack | undefined

    private _audioOpts?: AudioProcessorOptions | undefined
    private _workletNode?: AudioWorkletNode | undefined
    private _sourceNode?: MediaStreamAudioSourceNode | undefined
    private _worker?: Worker | undefined

    private _enabled = true
    private _options: ResolvedAudioPipelineOptions

    private readonly _commandTransport = new CommandTransport()
    private _operationQueue: Promise<void> = Promise.resolve()

    constructor(options: AudioPipelineOptions) {
        this._options = normalizeAudioPipelineOptions(options)
    }

    static isSupported(): boolean {
        return true
    }

    async init(opts: AudioProcessorOptions): Promise<void> {
        this._debug("init", opts)
        await this._initInternal(opts, false)
    }

    async restart(opts: AudioProcessorOptions): Promise<void> {
        opts.audioContext = opts.audioContext ?? this._audioOpts?.audioContext
        this._debug("restart", opts)
        await this._initInternal(opts, true)
    }

    async onPublish(room: Room): Promise<void> {
        this._debug("onPublish", room.name)
    }

    async onUnpublish(): Promise<void> {
        this._debug("onUnpublish")
    }

    async setEnabled(enable: boolean): Promise<void> {
        return this._runSerial(async () => {
            this._debug("setEnabled", enable)
            this._enabled = enable

            if (this._workletNode) {
                await this._sendCommand({ type: "SET_ENABLED", enable })
            }
        })
    }

    async setStageModule(stage: PipelineStage, moduleId: DenoiseModuleId): Promise<void> {
        return this._runSerial(async () => {
            if (stage !== "denoise") {
                throw new Error(`Unsupported stage: ${stage}`)
            }

            const nextModuleId = resolveDenoiseModule(moduleId)
            if (this._options.stages.denoise === nextModuleId) return

            if (this._workletNode) {
                await this._sendCommand({
                    type: "SET_STAGE_MODULE",
                    stage: "denoise",
                    moduleId: nextModuleId,
                })
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
                await this._applyRnnoiseConfig(config as RnnoiseModuleConfig)
            } else {
                await this._applyDeepFilterConfig(config as DeepFilterModuleConfig)
            }
        })
    }

    async isEnabled(): Promise<boolean> {
        return Boolean(this._workletNode && this._enabled)
    }

    async destroy(): Promise<void> {
        this._debug("destroy")
        this._closeInternal()
    }

    private async _applyRnnoiseConfig(config: RnnoiseModuleConfig): Promise<void> {
        const nextConfig = mergeRnnoiseConfig(this._options.moduleConfigs.rnnoise, config)

        if (this._workletNode) {
            await this._sendCommand({
                type: "SET_MODULE_CONFIG",
                moduleId: "rnnoise",
                config: { ...nextConfig },
            })
        }

        this._options.moduleConfigs.rnnoise = nextConfig
    }

    private async _applyDeepFilterConfig(config: DeepFilterModuleConfig): Promise<void> {
        const nextConfig = mergeDeepFilterConfig(this._options.moduleConfigs.deepfilternet, config)

        if (this._workletNode) {
            await this._sendCommand({
                type: "SET_MODULE_CONFIG",
                moduleId: "deepfilternet",
                config: { ...nextConfig },
            })
        }

        this._options.moduleConfigs.deepfilternet = nextConfig
    }

    private async _initInternal(opts: AudioProcessorOptions, restart: boolean): Promise<void> {
        if (!opts?.audioContext || !opts.track) {
            throw new Error("audioContext and track are required")
        }

        if (restart) this._closeInternal()

        this._audioOpts = opts
        const ctx = opts.audioContext

        await this._ensureWorkletLoaded(ctx)

        this._workletNode = new AudioWorkletNode(ctx, "AudioPipelineWorklet", {
            processorOptions: {
                debugLogs: this._options.debugLogs,
                numberOfChannels: opts.track.getSettings().channelCount,
            },
        })
        this._workletNode.port.onmessage = this._handleRuntimeMessage

        const currentModule = this._options.stages.denoise
        const moduleConfigs = this._createModuleConfigs()

        const { wasmBinaries, wasmTransferables } = await fetchWasmBinaries(
            this._options.wasmUrls,
            (message, data) => this._debug(message, data),
        )

        this._worker = new Worker(this._options.workerUrl)

        const channel = new MessageChannel()
        this._worker.postMessage({ type: "CONNECT_PORT", port: channel.port1 }, [channel.port1])

        const workerInitMsg: WorkletToWorkerMessage = {
            type: "INIT",
            wasmBinaries,
            moduleId: currentModule,
            moduleConfigs,
            debugLogs: this._options.debugLogs,
        }

        channel.port2.postMessage(workerInitMsg, wasmTransferables)

        const workerInfo = await this._waitForWorkerInit(channel.port2)
        this._debug("worker init complete", workerInfo)

        await this._sendCommand(
            {
                type: "INIT_PIPELINE",
                enable: this._enabled,
                debugLogs: this._options.debugLogs,
                workerPort: channel.port2,
                frameLength: workerInfo.frameLength,
                batchFrames: this._options.batchFrames,
                stages: { denoise: currentModule },
                moduleConfigs,
            },
            [channel.port2],
        )

        this._sourceNode = ctx.createMediaStreamSource(new MediaStream([opts.track]))
        this._sourceNode.connect(this._workletNode)

        const destination = ctx.createMediaStreamDestination()
        this._workletNode.connect(destination)
        this.processedTrack = destination.stream.getAudioTracks()[0]

        this._debug(
            "init complete",
            `sourceID: ${opts.track.id}, newTrackID: ${this.processedTrack.id}`,
        )
    }

    private async _ensureWorkletLoaded(ctx: BaseAudioContext): Promise<void> {
        const workletUrl = this._options.workletUrl
        if (!workletUrl) {
            throw new Error(
                "workletUrl is required. Pass AudioPipelineTrackProcessor({ workletUrl }).",
            )
        }

        if (AudioPipelineTrackProcessor._loadedContexts.has(ctx)) return

        this._debug("loading worklet", workletUrl)

        try {
            await ctx.audioWorklet.addModule(workletUrl)
            AudioPipelineTrackProcessor._loadedContexts.add(ctx)
        } catch (error) {
            throw new Error(
                `Failed to load audio pipeline worklet module: ${String(error)}. URL: ${workletUrl}`,
            )
        }
    }

    private _waitForWorkerInit(
        port: MessagePort,
    ): Promise<{ frameLength: number; lookahead: number }> {
        const t0 = performance.now()

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                port.onmessage = null
                reject(new Error(`Worker init timeout after ${COMMAND_TIMEOUT_MS}ms`))
            }, COMMAND_TIMEOUT_MS)

            const prevHandler = port.onmessage
            port.onmessage = (event: MessageEvent<WorkerToWorkletMessage>) => {
                const msg = event.data
                if (msg?.type === "INIT_OK") {
                    clearTimeout(timeout)
                    port.onmessage = prevHandler
                    this._debug("worker INIT_OK", `${(performance.now() - t0).toFixed(2)}ms`)
                    resolve({ frameLength: msg.frameLength, lookahead: msg.lookahead })
                } else if (msg?.type === "ERROR") {
                    clearTimeout(timeout)
                    port.onmessage = prevHandler
                    reject(new Error(`Worker init failed: ${msg.error}`))
                }
            }
        })
    }

    private _closeInternal(): void {
        if (this._workletNode) {
            try {
                this._workletNode.port.postMessage({ type: "DESTROY" })
            } catch {
                // Ignore postMessage errors during teardown.
            }
            this._workletNode.port.onmessage = null
        }

        if (this._worker) {
            try {
                this._worker.postMessage({ type: "DESTROY" })
            } catch {
                // Ignore postMessage errors during teardown.
            }
            this._worker.terminate()
            this._worker = undefined
        }

        this._commandTransport.close("Audio pipeline runtime closed")

        this._workletNode?.disconnect()
        this._sourceNode?.disconnect()

        this._workletNode = undefined
        this._sourceNode = undefined
        this.processedTrack = undefined
    }

    private readonly _handleRuntimeMessage = (event: MessageEvent<RuntimeMessage>): void => {
        const payload = event.data
        if (!payload?.type) return

        if (payload.type === "COMMAND_OK") {
            this._commandTransport.resolve(payload.requestId)
        } else if (payload.type === "COMMAND_ERROR") {
            this._handleCommandError(payload)
        } else if (payload.type === "LOG") {
            this._handleLog(payload)
        }
    }

    private _handleLog(payload: Extract<RuntimeMessage, { type: "LOG" }>): void {
        const prefix = `${payload.tag} ${payload.text}`
        if (payload.level === "error") {
            if (payload.data !== undefined) {
                console.error(prefix, payload.data)
            } else {
                console.error(prefix)
            }
        } else {
            if (payload.data !== undefined) {
                console.log(prefix, payload.data)
            } else {
                console.log(prefix)
            }
        }
    }

    private _handleCommandError(payload: Extract<RuntimeMessage, { type: "COMMAND_ERROR" }>): void {
        const errorMessage = payload.error ?? `Runtime command failed: ${payload.command ?? "unknown"}`
        const pendingCommand = this._commandTransport.getPendingCommand(payload.requestId)

        if (payload.requestId === undefined) {
            this._debug("COMMAND_ERROR (no requestId)", errorMessage)
            return
        }

        if (!pendingCommand) {
            this._debug("COMMAND_ERROR (stale)", errorMessage)
            return
        }

        this._commandTransport.reject(payload)
    }

    private _runSerial<T>(operation: () => Promise<T>): Promise<T> {
        const scheduled = this._operationQueue.then(operation, operation)
        this._operationQueue = scheduled.then(
            () => undefined,
            () => undefined,
        )
        return scheduled
    }

    private _createModuleConfigs(): WorkletModuleConfigPayloadMap {
        return {
            rnnoise: { ...this._options.moduleConfigs.rnnoise },
            deepfilternet: { ...this._options.moduleConfigs.deepfilternet },
        }
    }

    private async _sendCommand(
        message: MainToWorkletMessage,
        transferables?: Transferable[],
    ): Promise<void> {
        if (!this._workletNode) {
            throw new Error("Audio pipeline worklet is not initialized")
        }

        const t0 = performance.now()
        await this._commandTransport.send(this._workletNode.port, message, transferables)
        this._debug(`${message.type} round-trip`, `${(performance.now() - t0).toFixed(2)}ms`)
    }

    private static readonly _LOG_TAG = "[AudioPipeline:Main]"

    private _debug(action: string, data?: unknown): void {
        if (!this._options.debugLogs) return

        if (data !== undefined) {
            console.log(`${AudioPipelineTrackProcessor._LOG_TAG} ${action}`, data)
        } else {
            console.log(`${AudioPipelineTrackProcessor._LOG_TAG} ${action}`)
        }
    }
}
