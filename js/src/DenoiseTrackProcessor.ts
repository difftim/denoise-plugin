import { Track } from "livekit-client"
import type { AudioProcessorOptions, Room, TrackProcessor } from "livekit-client"
import { DenoiseOptions, type DeepFilterOptions, type DenoiserEngine } from "./options"

export type DenoiseFilterOptions = DenoiseOptions

const COMMAND_TIMEOUT_MS = 10000
const DEFAULT_VAD_LOG_INTERVAL_MS = 1000
const DEFAULT_DENOISER_ENGINE: DenoiserEngine = "rnnoise"
const DEFAULT_DF_ATTEN_LIM_DB = 100
const DEFAULT_DF_POST_FILTER_BETA = 0

interface DeepFilterRuntimeParams {
    attenLimDb?: number
    postFilterBeta?: number
}

export interface DeepFilterRuntimeConfig extends DeepFilterRuntimeParams {
    modelUrl?: string
    modelBuffer?: ArrayBuffer
}

interface WorkletDeepFilterPayload {
    modelBuffer?: ArrayBuffer
    clearModel?: boolean
    attenLimDb?: number
    postFilterBeta?: number
}

interface RuntimeMessage {
    message?: string
    requestId?: number
    command?: string
    error?: string
    level?: "info" | "error"
    logMessage?: string
    vadScore?: number
    intervalMs?: number
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
    deepFilter?: WorkletDeepFilterPayload
}

interface PendingCommand {
    command: string
    timeoutId: ReturnType<typeof setTimeout>
    resolve: () => void
    reject: (error: Error) => void
}

export class DenoiseTrackProcessor implements TrackProcessor<
    Track.Kind.Audio,
    AudioProcessorOptions
> {
    private static readonly loadedContexts = new WeakSet<BaseAudioContext>()
    private static readonly loadedWorkletUrls = new WeakMap<BaseAudioContext, string>()

    readonly name = "denoise-filter"
    processedTrack?: MediaStreamTrack | undefined

    private audioOpts?: AudioProcessorOptions | undefined
    private filterOpts?: DenoiseFilterOptions | undefined
    private denoiseNode?: AudioWorkletNode | undefined
    private orgSourceNode?: MediaStreamAudioSourceNode | undefined
    private enabled = true

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

        if (payload.message === "RUNTIME_LOG") {
            this._handleRuntimeLog(payload)
            return
        }

        if (this.filterOpts?.debugLogs) {
            console.log(`[DenoiserRuntime][Worklet][${payload.message}]`)
        }
    }

    constructor(options?: DenoiseFilterOptions) {
        const deepFilterOptions: DeepFilterOptions = {
            attenLimDb: this._resolveDeepFilterAttenLimDb(options?.deepFilter?.attenLimDb),
            postFilterBeta: this._resolveDeepFilterPostFilterBeta(
                options?.deepFilter?.postFilterBeta,
            ),
            modelUrl: this._resolveModelUrl(options?.deepFilter?.modelUrl),
        }

        this.filterOpts = {
            debugLogs: false,
            vadLogs: false,
            bufferOverflowMs: DEFAULT_VAD_LOG_INTERVAL_MS,
            engine: DEFAULT_DENOISER_ENGINE,
            ...options,
            deepFilter: deepFilterOptions,
        }
    }

    static isSupported(): boolean {
        return true
    }

    async init(opts: AudioProcessorOptions): Promise<void> {
        if (this.filterOpts?.debugLogs) {
            console.log("DenoiseTrackProcessor.init", opts)
        }

        await this._initInternal(opts, false)
    }

    async restart(opts: AudioProcessorOptions): Promise<void> {
        opts.audioContext = opts.audioContext ?? this.audioOpts?.audioContext

        if (this.filterOpts?.debugLogs) {
            console.log("DenoiseTrackProcessor.restart", opts)
        }

        await this._initInternal(opts, true)
    }

    async onPublish(room: Room): Promise<void> {
        if (this.filterOpts?.debugLogs) {
            console.log("DenoiseTrackProcessor.onPublish", room.name)
        }
    }

    async onUnpublish(): Promise<void> {
        if (this.filterOpts?.debugLogs) {
            console.log("DenoiseTrackProcessor.onUnpublish")
        }
    }

    async setEnabled(enable: boolean): Promise<void> {
        return this._runSerial(async () => {
            if (this.filterOpts?.debugLogs) {
                console.log("DenoiseTrackProcessor.setEnabled", enable)
            }

            this.enabled = enable

            if (this.denoiseNode) {
                await this._sendCommand({ message: "SET_ENABLED", enable })
            }
        })
    }

    async setEngine(engine: DenoiserEngine): Promise<void> {
        return this._runSerial(async () => {
            if (this.filterOpts?.debugLogs) {
                console.log("DenoiseTrackProcessor.setEngine", engine)
            }

            this._ensureFilterOptions()
            if (!this.filterOpts) {
                return
            }

            const resolvedEngine = engine === "deepfilternet" ? "deepfilternet" : "rnnoise"
            const currentEngine = this._getResolvedEngine()
            if (currentEngine === resolvedEngine) {
                return
            }

            if (!this.denoiseNode) {
                this._ensureFilterOptions()
                if (this.filterOpts) {
                    this.filterOpts.engine = resolvedEngine
                }
                return
            }

            let deepFilterPayload: WorkletDeepFilterPayload | undefined
            let transferables: Transferable[] | undefined

            if (resolvedEngine === "deepfilternet") {
                const deepFilter = this._resolveDeepFilterOptions()
                let modelBuffer: ArrayBuffer | undefined

                if (deepFilter.modelUrl) {
                    modelBuffer = await this._fetchDeepFilterModel(deepFilter.modelUrl)
                    transferables = [modelBuffer]
                }

                deepFilterPayload = {
                    modelBuffer,
                    attenLimDb: deepFilter.attenLimDb,
                    postFilterBeta: deepFilter.postFilterBeta,
                }
            }

            await this._sendCommand(
                {
                    message: "SET_ENGINE",
                    engine: resolvedEngine,
                    deepFilter: deepFilterPayload,
                },
                transferables,
            )

            this._ensureFilterOptions()
            if (this.filterOpts) {
                this.filterOpts.engine = resolvedEngine
            }
        })
    }

    async setDeepFilterParams(params: DeepFilterRuntimeParams): Promise<void> {
        return this._runSerial(async () => {
            if (this.filterOpts?.debugLogs) {
                console.log("DenoiseTrackProcessor.setDeepFilterParams", params)
            }

            this._ensureFilterOptions()
            if (!this.filterOpts) {
                return
            }

            const resolvedEngine = this._getResolvedEngine()
            if (resolvedEngine !== "deepfilternet") {
                if (this.filterOpts?.debugLogs) {
                    console.warn(
                        "DenoiseTrackProcessor.setDeepFilterParams ignored because current engine is rnnoise",
                    )
                }
                return
            }

            const currentDeepFilter = this._resolveDeepFilterOptions()
            const resolved: DeepFilterOptions = {
                ...currentDeepFilter,
                attenLimDb: this._resolveDeepFilterAttenLimDb(
                    params.attenLimDb ?? currentDeepFilter.attenLimDb,
                ),
                postFilterBeta: this._resolveDeepFilterPostFilterBeta(
                    params.postFilterBeta ?? currentDeepFilter.postFilterBeta,
                ),
                modelUrl: this._resolveModelUrl(currentDeepFilter.modelUrl),
            }

            if (this.denoiseNode) {
                await this._sendCommand({
                    message: "SET_DEEPFILTER_PARAMS",
                    deepFilter: {
                        attenLimDb: resolved.attenLimDb,
                        postFilterBeta: resolved.postFilterBeta,
                    },
                })
            }

            this._ensureFilterOptions()
            if (this.filterOpts) {
                this.filterOpts.deepFilter = resolved
            }
        })
    }

    async setDeepFilterConfig(config: DeepFilterRuntimeConfig): Promise<void> {
        return this._runSerial(async () => {
            if (this.filterOpts?.debugLogs) {
                console.log("DenoiseTrackProcessor.setDeepFilterConfig", config)
            }

            this._ensureFilterOptions()
            if (!this.filterOpts) {
                return
            }

            const resolvedEngine = this._getResolvedEngine()
            if (resolvedEngine !== "deepfilternet") {
                if (this.filterOpts?.debugLogs) {
                    console.warn(
                        "DenoiseTrackProcessor.setDeepFilterConfig ignored because current engine is rnnoise",
                    )
                }
                return
            }

            const currentDeepFilter = this._resolveDeepFilterOptions()
            const currentModelUrl = this._resolveModelUrl(currentDeepFilter.modelUrl)
            const nextModelUrl =
                config.modelUrl !== undefined
                    ? this._resolveModelUrl(config.modelUrl)
                    : currentModelUrl

            const attenLimDb = this._resolveDeepFilterAttenLimDb(
                config.attenLimDb ?? currentDeepFilter.attenLimDb,
            )
            const postFilterBeta = this._resolveDeepFilterPostFilterBeta(
                config.postFilterBeta ?? currentDeepFilter.postFilterBeta,
            )

            let modelBuffer: ArrayBuffer | undefined
            if (config.modelBuffer !== undefined) {
                if (config.modelBuffer.byteLength <= 0) {
                    throw new Error("DeepFilter modelBuffer is empty")
                }
                modelBuffer = config.modelBuffer.slice(0)
            } else if (config.modelUrl !== undefined && nextModelUrl) {
                modelBuffer = await this._fetchDeepFilterModel(nextModelUrl)
            }

            const clearModel =
                config.modelBuffer === undefined &&
                config.modelUrl !== undefined &&
                nextModelUrl === undefined

            if (this.denoiseNode) {
                await this._sendCommand(
                    {
                        message: "SET_DEEPFILTER_CONFIG",
                        deepFilter: {
                            modelBuffer,
                            clearModel,
                            attenLimDb,
                            postFilterBeta,
                        },
                    },
                    modelBuffer ? [modelBuffer] : undefined,
                )
            }

            this._ensureFilterOptions()
            if (this.filterOpts) {
                this.filterOpts.deepFilter = {
                    ...this.filterOpts.deepFilter,
                    modelUrl: nextModelUrl,
                    attenLimDb,
                    postFilterBeta,
                }
            }
        })
    }

    async isEnabled(): Promise<boolean> {
        if (this.denoiseNode) {
            return this.enabled
        }

        return false
    }

    async destroy(): Promise<void> {
        if (this.filterOpts?.debugLogs) {
            console.log("DenoiseTrackProcessor.destroy")
        }

        this._closeInternal()
    }

    async _initInternal(opts: AudioProcessorOptions, restart: boolean): Promise<void> {
        if (!opts || !opts.audioContext || !opts.track) {
            throw new Error("audioContext and track are required")
        }

        if (restart) {
            this._closeInternal()
        }

        this.audioOpts = opts
        const ctx = this.audioOpts.audioContext

        const workletUrl = this.filterOpts?.workletUrl
        if (!workletUrl) {
            throw new Error("workletUrl is required. Pass DenoiseTrackProcessor({ workletUrl }).")
        }

        let resolvedWorkletUrl = DenoiseTrackProcessor.loadedWorkletUrls.get(ctx)

        if (!DenoiseTrackProcessor.loadedContexts.has(ctx)) {
            if (this.filterOpts?.debugLogs) {
                console.log("DenoiserWorkletURL:", workletUrl)
            }

            try {
                await ctx.audioWorklet.addModule(workletUrl)
                DenoiseTrackProcessor.loadedContexts.add(ctx)
                DenoiseTrackProcessor.loadedWorkletUrls.set(ctx, workletUrl)
                resolvedWorkletUrl = workletUrl
            } catch (error) {
                throw new Error(
                    `Failed to load denoiser worklet module: ${String(error)}. URL: ${workletUrl}`,
                )
            }
        } else if (!resolvedWorkletUrl) {
            resolvedWorkletUrl = workletUrl
            DenoiseTrackProcessor.loadedWorkletUrls.set(ctx, workletUrl)
        }

        if (this.filterOpts?.debugLogs) {
            console.log("DenoiserWorkletResolvedURL:", resolvedWorkletUrl)
        }

        this.denoiseNode = new AudioWorkletNode(ctx, "DenoiserWorklet", {
            processorOptions: {
                debugLogs: this.filterOpts?.debugLogs,
                numberOfChannels: this.audioOpts.track.getSettings().channelCount,
            },
        })
        this.denoiseNode.port.onmessage = this._handleRuntimeMessage

        const resolvedEngine = this._getResolvedEngine()
        const resolvedDeepFilter = this._resolveDeepFilterOptions()

        let initModelBuffer: ArrayBuffer | undefined
        if (resolvedEngine === "deepfilternet" && resolvedDeepFilter.modelUrl) {
            initModelBuffer = await this._fetchDeepFilterModel(resolvedDeepFilter.modelUrl)
        }

        await this._sendCommand(
            {
                message: "INIT_RUNTIME",
                sampleRate: 48000,
                enable: this.enabled,
                debugLogs: this.filterOpts?.debugLogs,
                vadLogs: this.filterOpts?.vadLogs,
                bufferOverflowMs: this._getVadLogIntervalMs(),
                engine: resolvedEngine,
                deepFilter: {
                    modelBuffer: initModelBuffer,
                    attenLimDb: resolvedDeepFilter.attenLimDb,
                    postFilterBeta: resolvedDeepFilter.postFilterBeta,
                },
            },
            initModelBuffer ? [initModelBuffer] : undefined,
        )

        this.orgSourceNode = ctx.createMediaStreamSource(new MediaStream([this.audioOpts.track]))
        this.orgSourceNode.connect(this.denoiseNode)

        const destination = ctx.createMediaStreamDestination()
        this.denoiseNode.connect(destination)

        this.processedTrack = destination.stream.getAudioTracks()[0]

        if (this.filterOpts?.debugLogs) {
            console.log(
                `DenoiseTrackProcessor.init: sourceID: ${this.audioOpts.track.id}, newTrackID: ${this.processedTrack.id}`,
            )
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
        if (!this.denoiseNode) {
            throw new Error("Denoiser worklet is not initialized")
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
            if (this.filterOpts?.debugLogs) {
                console.error(`[DenoiserRuntime][Worklet][COMMAND_ERROR] ${errorMessage}`)
            }
            return
        }

        const pending = this._pendingCommands.get(requestId)
        if (!pending) {
            if (this.filterOpts?.debugLogs) {
                console.error(`[DenoiserRuntime][Worklet][COMMAND_ERROR] ${errorMessage}`)
            }
            return
        }

        clearTimeout(pending.timeoutId)
        this._pendingCommands.delete(requestId)
        pending.reject(new Error(errorMessage))
    }

    private _handleRuntimeLog(payload: RuntimeMessage) {
        const shouldLog = this.filterOpts?.debugLogs || payload.level === "error"
        if (!shouldLog) {
            return
        }

        const logLabel = payload.logMessage ?? "RUNTIME_LOG"

        if (logLabel === "DENOISER_WORKLET_VAD") {
            const vadScore =
                typeof payload.vadScore === "number" && Number.isFinite(payload.vadScore)
                    ? payload.vadScore.toFixed(4)
                    : "n/a"
            const intervalMs =
                typeof payload.intervalMs === "number" && Number.isFinite(payload.intervalMs)
                    ? payload.intervalMs
                    : this._getVadLogIntervalMs()

            console.log(
                `[DenoiserRuntime][Worklet][${logLabel}] vadScore=${vadScore} intervalMs=${intervalMs}`,
            )
            return
        }

        if (payload.level === "error") {
            console.error(`[DenoiserRuntime][Worklet][${logLabel}]`)
            return
        }

        console.log(`[DenoiserRuntime][Worklet][${logLabel}]`)
    }

    private _rejectAllPendingCommands(reason: string) {
        for (const pending of this._pendingCommands.values()) {
            clearTimeout(pending.timeoutId)
            pending.reject(new Error(reason))
        }

        this._pendingCommands.clear()
    }

    private _getVadLogIntervalMs(): number {
        const interval = this.filterOpts?.bufferOverflowMs
        if (!Number.isFinite(interval) || (interval ?? 0) <= 0) {
            return DEFAULT_VAD_LOG_INTERVAL_MS
        }
        return interval ?? DEFAULT_VAD_LOG_INTERVAL_MS
    }

    private _getResolvedEngine(): DenoiserEngine {
        this._ensureFilterOptions()
        const engine = this.filterOpts?.engine
        if (engine === "deepfilternet" || engine === "rnnoise") {
            return engine
        }
        return DEFAULT_DENOISER_ENGINE
    }

    private _resolveDeepFilterOptions(): DeepFilterOptions {
        this._ensureFilterOptions()

        const options = this.filterOpts?.deepFilter

        return {
            modelUrl: this._resolveModelUrl(options?.modelUrl),
            attenLimDb: this._resolveDeepFilterAttenLimDb(options?.attenLimDb),
            postFilterBeta: this._resolveDeepFilterPostFilterBeta(options?.postFilterBeta),
        }
    }

    private _resolveModelUrl(value?: string): string | undefined {
        if (typeof value !== "string") {
            return undefined
        }

        const trimmed = value.trim()
        if (trimmed.length === 0) {
            return undefined
        }

        return trimmed
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

    private _ensureFilterOptions() {
        const existing = this.filterOpts

        const deepFilter = {
            modelUrl: this._resolveModelUrl(existing?.deepFilter?.modelUrl),
            attenLimDb: this._resolveDeepFilterAttenLimDb(existing?.deepFilter?.attenLimDb),
            postFilterBeta: this._resolveDeepFilterPostFilterBeta(
                existing?.deepFilter?.postFilterBeta,
            ),
        }

        this.filterOpts = {
            debugLogs: false,
            vadLogs: false,
            bufferOverflowMs: DEFAULT_VAD_LOG_INTERVAL_MS,
            engine: DEFAULT_DENOISER_ENGINE,
            ...existing,
            deepFilter,
        }
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

    _closeInternal() {
        if (this.denoiseNode) {
            try {
                this.denoiseNode.port.postMessage({ message: "DESTROY" })
            } catch (_error) {
                // Ignore postMessage errors when closing.
            }
            this.denoiseNode.port.onmessage = null
        }

        this._rejectAllPendingCommands("Denoiser runtime closed")

        this.denoiseNode?.disconnect()
        this.orgSourceNode?.disconnect()

        this.denoiseNode = undefined
        this.orgSourceNode = undefined
        this.processedTrack = undefined
    }
}
