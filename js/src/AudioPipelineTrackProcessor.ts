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
    WasmBinaries,
    WorkletDeepFilterConfigPayload,
} from "./shared/contracts"
import { COMMAND_TIMEOUT_MS } from "./shared/contracts"
import {
    cloneArrayBuffer,
    mergeDeepFilterConfig,
    mergeRnnoiseConfig,
    normalizeAudioPipelineOptions,
    resolveDenoiseModule,
    type InternalWasmUrls,
    type ResolvedAudioPipelineOptions,
    type ResolvedDeepFilterModuleConfig,
} from "./shared/normalize"
import type { WorkerToWorkletMessage, WorkletToWorkerMessage } from "./shared/worker-contracts"

interface PendingCommand {
    command: string
    timeoutId: ReturnType<typeof setTimeout>
    resolve: () => void
    reject: (error: Error) => void
}

export class AudioPipelineTrackProcessor implements TrackProcessor<
    Track.Kind.Audio,
    AudioProcessorOptions
> {
    private static readonly _loadedContexts = new WeakSet<BaseAudioContext>()
    private static readonly _loadedWorkletUrls = new WeakMap<BaseAudioContext, string>()

    readonly name = "audio-pipeline-filter"
    processedTrack?: MediaStreamTrack | undefined

    private _audioOpts?: AudioProcessorOptions | undefined
    private _workletNode?: AudioWorkletNode | undefined
    private _sourceNode?: MediaStreamAudioSourceNode | undefined
    private _worker?: Worker | undefined

    private _enabled = true
    private _options: ResolvedAudioPipelineOptions

    private _nextRequestId = 1
    private _pendingCommands = new Map<number, PendingCommand>()
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
                await this._sendCommand({ message: "SET_ENABLED", enable })
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
                    message: "SET_STAGE_MODULE",
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

    // ── Module config application ──────────────────────────────────

    private async _applyRnnoiseConfig(config: RnnoiseModuleConfig): Promise<void> {
        const nextConfig = mergeRnnoiseConfig(this._options.moduleConfigs.rnnoise, config)

        if (this._workletNode) {
            await this._sendCommand({
                message: "SET_MODULE_CONFIG",
                moduleId: "rnnoise",
                config: { ...nextConfig },
            })
        }

        this._options.moduleConfigs.rnnoise = nextConfig
    }

    private async _applyDeepFilterConfig(config: DeepFilterModuleConfig): Promise<void> {
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
                modelBuffer = await this._fetchBinary(nextConfig.modelUrl, "DeepFilter model")
                nextConfig.modelBuffer = cloneArrayBuffer(modelBuffer)
            } else {
                clearModel = true
                nextConfig.modelBuffer = undefined
            }
        } else if (config.clearModel === true) {
            clearModel = true
            nextConfig.modelBuffer = undefined
        }

        if (this._workletNode) {
            const payload: WorkletDeepFilterConfigPayload = {
                attenLimDb: nextConfig.attenLimDb,
                postFilterBeta: nextConfig.postFilterBeta,
                modelBuffer,
                clearModel,
            }

            await this._sendCommand(
                { message: "SET_MODULE_CONFIG", moduleId: "deepfilternet", config: payload },
                modelBuffer ? [modelBuffer] : undefined,
            )
        }

        this._options.moduleConfigs.deepfilternet = nextConfig
    }

    // ── Init / teardown ────────────────────────────────────────────

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
        const deepConfig = this._options.moduleConfigs.deepfilternet

        const { wasmBinaries, wasmTransferables } = await this._fetchWasmBinaries(
            this._options.wasmUrls,
        )

        const initModelBuffer = await this._resolveModelBuffer(deepConfig)
        if (initModelBuffer) {
            this._options.moduleConfigs.deepfilternet.modelBuffer =
                cloneArrayBuffer(initModelBuffer)
        }

        this._worker = new Worker(this._options.workerUrl)

        const channel = new MessageChannel()

        this._worker.postMessage({ type: "CONNECT_PORT", port: channel.port1 }, [channel.port1])

        const workerInitMsg: WorkletToWorkerMessage = {
            type: "INIT",
            wasmBinaries,
            moduleId: currentModule,
            moduleConfigs: {
                rnnoise: { ...this._options.moduleConfigs.rnnoise },
                deepfilternet: {
                    attenLimDb: deepConfig.attenLimDb,
                    postFilterBeta: deepConfig.postFilterBeta,
                    modelBuffer: initModelBuffer,
                },
            },
            debugLogs: this._options.debugLogs,
        }

        const initTransferables: Transferable[] = [...wasmTransferables]
        if (initModelBuffer) initTransferables.push(initModelBuffer)
        channel.port2.postMessage(workerInitMsg, initTransferables)

        const workerInfo = await this._waitForWorkerInit(channel.port2)
        this._debug("worker init complete", workerInfo)

        await this._sendCommand(
            {
                message: "INIT_PIPELINE",
                enable: this._enabled,
                debugLogs: this._options.debugLogs,
                workerPort: channel.port2,
                frameLength: workerInfo.frameLength,
                batchFrames: this._options.batchFrames,
                stages: { denoise: currentModule },
                moduleConfigs: {
                    rnnoise: { ...this._options.moduleConfigs.rnnoise },
                    deepfilternet: {
                        attenLimDb: deepConfig.attenLimDb,
                        postFilterBeta: deepConfig.postFilterBeta,
                    },
                },
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
            AudioPipelineTrackProcessor._loadedWorkletUrls.set(ctx, workletUrl)
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
                this._workletNode.port.postMessage({ message: "DESTROY" })
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

        this._rejectAllPendingCommands("Audio pipeline runtime closed")

        this._workletNode?.disconnect()
        this._sourceNode?.disconnect()

        this._workletNode = undefined
        this._sourceNode = undefined
        this.processedTrack = undefined
    }

    // ── WASM + Model helpers ──────────────────────────────────────

    private async _fetchWasmBinaries(urls: InternalWasmUrls): Promise<{
        wasmBinaries: WasmBinaries
        wasmTransferables: ArrayBuffer[]
    }> {
        const wasmBinaries: WasmBinaries = {}
        const wasmTransferables: ArrayBuffer[] = []

        this._debug("fetching rnnoise wasm", urls.rnnoise)
        const rnnoiseWasm = await this._fetchBinary(urls.rnnoise, "RNNoise WASM")
        wasmBinaries.rnnoiseWasm = rnnoiseWasm
        wasmTransferables.push(rnnoiseWasm)

        this._debug("fetching deepfilter wasm", urls.deepfilter)
        const deepfilterWasm = await this._fetchBinary(urls.deepfilter, "DeepFilter WASM")
        wasmBinaries.deepfilterWasm = deepfilterWasm
        wasmTransferables.push(deepfilterWasm)

        return { wasmBinaries, wasmTransferables }
    }

    private async _resolveModelBuffer(
        config: ResolvedDeepFilterModuleConfig,
    ): Promise<ArrayBuffer | undefined> {
        if (config.modelBuffer) return cloneArrayBuffer(config.modelBuffer)
        if (!config.modelUrl) return undefined
        return this._fetchBinary(config.modelUrl, "DeepFilter model")
    }

    private async _fetchBinary(url: string, label: string): Promise<ArrayBuffer> {
        const response = await fetch(url)
        if (!response.ok) {
            throw new Error(
                `Failed to fetch ${label}: ${response.status} ${response.statusText} (${url})`,
            )
        }
        return response.arrayBuffer()
    }

    // ── Command transport ──────────────────────────────────────────

    private readonly _handleRuntimeMessage = (event: MessageEvent<RuntimeMessage>): void => {
        const payload = event.data
        if (!payload?.message) return

        if (payload.message === "COMMAND_OK") {
            this._resolvePending(payload.requestId)
        } else if (payload.message === "COMMAND_ERROR") {
            this._rejectPending(payload)
        } else if (payload.message === "LOG") {
            this._handleLog(payload)
        }
    }

    private _handleLog(payload: Extract<RuntimeMessage, { message: "LOG" }>): void {
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
        if (!this._workletNode) {
            throw new Error("Audio pipeline worklet is not initialized")
        }

        const requestId = this._nextRequestId++
        const t0 = performance.now()

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
                this._workletNode?.port.postMessage({ ...message, requestId }, transferables ?? [])
            } catch (error) {
                clearTimeout(timeoutId)
                this._pendingCommands.delete(requestId)
                reject(error instanceof Error ? error : new Error(String(error)))
            }
        })

        this._debug(`${message.message} round-trip`, `${(performance.now() - t0).toFixed(2)}ms`)
    }

    private _resolvePending(requestId?: number): void {
        if (requestId === undefined) return

        const pending = this._pendingCommands.get(requestId)
        if (!pending) return

        clearTimeout(pending.timeoutId)
        this._pendingCommands.delete(requestId)
        pending.resolve()
    }

    private _rejectPending(payload: Extract<RuntimeMessage, { message: "COMMAND_ERROR" }>): void {
        const errorMessage =
            payload.error ?? `Runtime command failed: ${payload.command ?? "unknown"}`

        if (payload.requestId === undefined) {
            this._debug("COMMAND_ERROR (no requestId)", errorMessage)
            return
        }

        const pending = this._pendingCommands.get(payload.requestId)
        if (!pending) {
            this._debug("COMMAND_ERROR (stale)", errorMessage)
            return
        }

        clearTimeout(pending.timeoutId)
        this._pendingCommands.delete(payload.requestId)
        pending.reject(new Error(errorMessage))
    }

    private _rejectAllPendingCommands(reason: string): void {
        for (const pending of this._pendingCommands.values()) {
            clearTimeout(pending.timeoutId)
            pending.reject(new Error(reason))
        }
        this._pendingCommands.clear()
    }

    // ── Debug logging ──────────────────────────────────────────────

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
