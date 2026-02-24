import { Track } from "livekit-client"
import type { AudioProcessorOptions, Room, TrackProcessor } from "livekit-client"
import { DenoiseOptions, type DeepFilterOptions, type DenoiserEngine } from "./options"
import {
    CONTROL_DESTROY_INDEX,
    CONTROL_ENABLED_INDEX,
    CONTROL_SIGNAL_INDEX,
    SharedBufferPayload,
    createSharedBufferPayload,
} from "./sharedMemory"

export type DenoiseFilterOptions = DenoiseOptions
const DEFAULT_VAD_LOG_INTERVAL_MS = 1000
const DEFAULT_DENOISER_ENGINE: DenoiserEngine = "rnnoise"
const DEFAULT_DF_ATTEN_LIM_DB = 100
const DEFAULT_DF_POST_FILTER_BETA = 0

interface DeepFilterRuntimeParams {
    attenLimDb?: number
    postFilterBeta?: number
}

interface RuntimeMessage {
    message?: string
    error?: string
    vadScore?: number
    intervalMs?: number
}

interface MainToWorkerMessage {
    message: string
    sampleRate?: number
    enable?: boolean
    debugLogs?: boolean
    vadLogs?: boolean
    bufferOverflowMs?: number
    engine?: DenoiserEngine
    deepFilter?: DeepFilterOptions
    sharedBuffers?: SharedBufferPayload
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
    private denoiseWorker?: Worker | undefined
    private orgSourceNode?: MediaStreamAudioSourceNode | undefined
    private enabled: boolean = true
    private _sharedControlView?: Int32Array

    private readonly _handleRuntimeMessage = (event: MessageEvent<RuntimeMessage>) => {
        if (!this.filterOpts?.debugLogs) {
            return
        }

        const payload = event.data
        if (!payload?.message) {
            return
        }

        const fromWorklet = payload.message.includes("WORKLET")
        const sourceTag = fromWorklet ? "[DenoiserRuntime][Worklet]" : "[DenoiserRuntime][Worker]"

        if (payload.message === "DENOISER_WORKER_VAD") {
            const vadScore =
                typeof payload.vadScore === "number" && Number.isFinite(payload.vadScore)
                    ? payload.vadScore.toFixed(4)
                    : "n/a"
            const intervalMs =
                typeof payload.intervalMs === "number" && Number.isFinite(payload.intervalMs)
                    ? payload.intervalMs
                    : this._getVadLogIntervalMs()
            console.log(
                `${sourceTag}[${payload.message}] vadScore=${vadScore} intervalMs=${intervalMs}`,
            )
            return
        }

        if (payload.message.endsWith("ERROR")) {
            console.error(
                `${sourceTag}[${payload.message}] ${payload.error ?? "Unknown runtime error"}`,
            )
            return
        }

        console.log(`${sourceTag}[${payload.message}]`)
    }

    constructor(options?: DenoiseFilterOptions) {
        const deepFilterOptions: DeepFilterOptions = {
            attenLimDb: DEFAULT_DF_ATTEN_LIM_DB,
            postFilterBeta: DEFAULT_DF_POST_FILTER_BETA,
            ...options?.deepFilter,
        }
        deepFilterOptions.attenLimDb = this._resolveDeepFilterAttenLimDb(deepFilterOptions.attenLimDb)
        deepFilterOptions.postFilterBeta = this._resolveDeepFilterPostFilterBeta(
            deepFilterOptions.postFilterBeta,
        )

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
        // restart with empty audio context
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
        if (this.filterOpts?.debugLogs) {
            console.log("DenoiseTrackProcessor.setEnabled", enable)
        }

        this.enabled = enable
        this._setSharedEnabled(enable)
        this.denoiseNode?.port.postMessage({ message: "SET_ENABLED", enable })
    }

    async setEngine(engine: DenoiserEngine): Promise<void> {
        if (this.filterOpts?.debugLogs) {
            console.log("DenoiseTrackProcessor.setEngine", engine)
        }

        this._ensureFilterOptions()
        const filterOpts = this.filterOpts
        if (!filterOpts) {
            return
        }
        if (filterOpts.engine === engine) {
            return
        }
        filterOpts.engine = engine

        if (!this.audioOpts) {
            return
        }

        await this.restart({ ...this.audioOpts })
    }

    async setDeepFilterParams(params: DeepFilterRuntimeParams): Promise<void> {
        if (this.filterOpts?.debugLogs) {
            console.log("DenoiseTrackProcessor.setDeepFilterParams", params)
        }

        this._ensureFilterOptions()
        const filterOpts = this.filterOpts
        if (!filterOpts) {
            return
        }
        const resolved: DeepFilterOptions = {
            ...filterOpts.deepFilter,
            ...params,
            attenLimDb: this._resolveDeepFilterAttenLimDb(
                params.attenLimDb ?? filterOpts.deepFilter?.attenLimDb,
            ),
            postFilterBeta: this._resolveDeepFilterPostFilterBeta(
                params.postFilterBeta ?? filterOpts.deepFilter?.postFilterBeta,
            ),
        }
        filterOpts.deepFilter = resolved

        this.denoiseWorker?.postMessage({
            message: "UPDATE_DEEPFILTER_PARAMS",
            deepFilter: {
                attenLimDb: resolved.attenLimDb,
                postFilterBeta: resolved.postFilterBeta,
            },
        } as MainToWorkerMessage)
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

        this._ensureSharedArrayBufferSupport()

        this.audioOpts = opts
        const ctx = this.audioOpts.audioContext
        const workletUrl = this.filterOpts?.workletUrl
        if (!workletUrl) {
            throw new Error(
                "workletUrl is required. Pass DenoiseTrackProcessor({ workletUrl, workerUrl }).",
            )
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

        const workerUrl = this._resolveWorkerURL(resolvedWorkletUrl)
        const resolvedEngine = this._getResolvedEngine()
        const resolvedDeepFilter =
            resolvedEngine === "deepfilternet"
                ? this._resolveDeepFilterOptions()
                : undefined

        if (this.filterOpts?.debugLogs) {
            console.log("DenoiserWorkerURL:", workerUrl)
        }

        try {
            this.denoiseWorker = new Worker(workerUrl)
            this.denoiseWorker.onmessage = this._handleRuntimeMessage
            this.denoiseWorker.onerror = (event) => {
                if (this.filterOpts?.debugLogs) {
                    console.error("[DenoiserRuntime][Worker][OnError]", event)
                }
            }
        } catch (error) {
            throw new Error(`Failed to create denoiser worker: ${String(error)}. URL: ${workerUrl}`)
        }

        this.denoiseNode = new AudioWorkletNode(ctx, "DenoiserWorklet", {
            processorOptions: {
                debugLogs: this.filterOpts?.debugLogs,
                numberOfChannels: this.audioOpts.track.getSettings().channelCount,
            },
        })
        this.denoiseNode.port.onmessage = this._handleRuntimeMessage

        const sharedBuffers = createSharedBufferPayload()
        this._sharedControlView = new Int32Array(sharedBuffers.controlState)
        this._setSharedEnabled(this.enabled)
        Atomics.store(this._sharedControlView, CONTROL_DESTROY_INDEX, 0)

        this.denoiseNode.port.postMessage({
            message: "ATTACH_SHARED_BUFFERS",
            sharedBuffers,
        })
        this.denoiseWorker.postMessage({
            message: "ATTACH_SHARED_BUFFERS",
            sharedBuffers,
        } as MainToWorkerMessage)
        this.denoiseWorker.postMessage({
            message: "INIT",
            sampleRate: ctx.sampleRate,
            debugLogs: this.filterOpts?.debugLogs,
            vadLogs: this.filterOpts?.vadLogs,
            bufferOverflowMs: this._getVadLogIntervalMs(),
            engine: resolvedEngine,
            deepFilter: resolvedDeepFilter,
        } as MainToWorkerMessage)
        this.denoiseNode.port.postMessage({ message: "SET_ENABLED", enable: this.enabled })

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

    private _ensureSharedArrayBufferSupport() {
        const userAgent = globalThis.navigator?.userAgent ?? ""
        const isElectronRuntime = /\bElectron\/\d+/i.test(userAgent)

        if (typeof SharedArrayBuffer === "undefined") {
            if (isElectronRuntime) {
                throw new Error(
                    "SharedArrayBuffer is unavailable in this Electron context. Configure BrowserWindow.webPreferences.enableBlinkFeatures='SharedArrayBuffer'.",
                )
            }
            throw new Error(
                "SharedArrayBuffer is unavailable in this context. Enable cross-origin isolation (COOP/COEP).",
            )
        }

        if (
            typeof globalThis.crossOriginIsolated === "boolean" &&
            globalThis.crossOriginIsolated === false &&
            !isElectronRuntime
        ) {
            throw new Error(
                "SharedArrayBuffer requires cross-origin isolation. Serve with COOP: same-origin and COEP: require-corp.",
            )
        }
    }

    private _setSharedEnabled(enable: boolean) {
        if (!this._sharedControlView) {
            return
        }

        Atomics.store(this._sharedControlView, CONTROL_ENABLED_INDEX, enable ? 1 : 0)
        Atomics.add(this._sharedControlView, CONTROL_SIGNAL_INDEX, 1)
        Atomics.notify(this._sharedControlView, CONTROL_SIGNAL_INDEX, 1)
    }

    private _requestSharedDestroy() {
        if (!this._sharedControlView) {
            return
        }

        Atomics.store(this._sharedControlView, CONTROL_DESTROY_INDEX, 1)
        Atomics.add(this._sharedControlView, CONTROL_SIGNAL_INDEX, 1)
        Atomics.notify(this._sharedControlView, CONTROL_SIGNAL_INDEX, 1)
    }

    private _resolveWorkerURL(workletUrl: string): string {
        if (this.filterOpts?.workerUrl) {
            return this.filterOpts.workerUrl
        }

        const derived = this._derivePeerAssetURL(workletUrl, "DenoiserWorker.js")
        if (derived) {
            return derived
        }

        throw new Error(
            "workerUrl is required when it cannot be derived from workletUrl. Pass DenoiseTrackProcessor({ workletUrl, workerUrl }).",
        )
    }

    private _derivePeerAssetURL(sourceUrl: string, targetFileName: string): string | undefined {
        if (!sourceUrl.includes("DenoiserWorklet.js")) {
            return undefined
        }

        try {
            const resolved = new URL(sourceUrl, globalThis.location?.href)
            resolved.pathname = resolved.pathname.replace(/DenoiserWorklet\.js$/, targetFileName)
            return resolved.toString()
        } catch (_error) {
            return sourceUrl.replace("DenoiserWorklet.js", targetFileName)
        }
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
        const modelUrl =
            typeof options?.modelUrl === "string" && options.modelUrl.trim().length > 0
                ? options.modelUrl
                : undefined

        return {
            modelUrl,
            attenLimDb: this._resolveDeepFilterAttenLimDb(options?.attenLimDb),
            postFilterBeta: this._resolveDeepFilterPostFilterBeta(options?.postFilterBeta),
        }
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
            ...existing?.deepFilter,
            attenLimDb: this._resolveDeepFilterAttenLimDb(existing?.deepFilter?.attenLimDb),
            postFilterBeta: this._resolveDeepFilterPostFilterBeta(existing?.deepFilter?.postFilterBeta),
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

    _closeInternal() {
        this._requestSharedDestroy()

        this.denoiseNode?.port.postMessage({ message: "DESTORY" })
        if (this.denoiseNode) {
            this.denoiseNode.port.onmessage = null
        }

        this.denoiseWorker?.postMessage({ message: "DESTROY" } as MainToWorkerMessage)
        if (this.denoiseWorker) {
            this.denoiseWorker.onmessage = null
            this.denoiseWorker.onerror = null
            this.denoiseWorker.terminate()
        }

        this.denoiseNode?.disconnect()
        this.orgSourceNode?.disconnect()
        this.denoiseNode = undefined
        this.denoiseWorker = undefined
        this.orgSourceNode = undefined
        this.processedTrack = undefined
        this._sharedControlView = undefined
    }
}
