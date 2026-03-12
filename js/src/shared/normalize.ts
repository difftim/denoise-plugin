import type {
    AudioPipelineOptions,
    DenoiseModuleId,
    DeepFilterModuleConfig,
    RnnoiseModuleConfig,
} from "../options"

export const DEFAULT_DENOISE_MODULE: DenoiseModuleId = "rnnoise"
export const DEFAULT_RNNOISE_VAD_LOG_INTERVAL_MS = 1000
export const DEFAULT_DF_ATTEN_LIM_DB = 100
export const DEFAULT_DF_POST_FILTER_BETA = 0
export const DEFAULT_DF_MIN_DB_THRESH = -15
export const DEFAULT_DF_MAX_DB_ERB_THRESH = 35
export const DEFAULT_DF_MAX_DB_DF_THRESH = 35

export interface ResolvedRnnoiseModuleConfig {
    vadLogs: boolean
    bufferOverflowMs: number
}

export interface ResolvedDeepFilterModuleConfig {
    attenLimDb: number
    postFilterBeta: number
    minDbThresh: number
    maxDbErbThresh: number
    maxDbDfThresh: number
}

export const DEFAULT_RNNOISE_WASM_FILENAME = "rnnoise.wasm"
export const DEFAULT_DEEPFILTER_WASM_FILENAME = "deepfilter.wasm"

export interface InternalWasmUrls {
    rnnoise: string
    deepfilter: string
}

export interface ResolvedAudioPipelineOptions {
    workletUrl: string
    workerUrl: string
    wasmUrls: InternalWasmUrls
    debugLogs: boolean
    batchFrames: number
    stages: {
        denoise: DenoiseModuleId
    }
    moduleConfigs: {
        rnnoise: ResolvedRnnoiseModuleConfig
        deepfilternet: ResolvedDeepFilterModuleConfig
    }
}

export function resolveDenoiseModule(moduleId?: DenoiseModuleId): DenoiseModuleId {
    if (moduleId === "deepfilternet") {
        return "deepfilternet"
    }
    return "rnnoise"
}

function resolveVadLogIntervalMs(value?: number): number {
    if (!Number.isFinite(value) || (value ?? 0) <= 0) {
        return DEFAULT_RNNOISE_VAD_LOG_INTERVAL_MS
    }
    return value ?? DEFAULT_RNNOISE_VAD_LOG_INTERVAL_MS
}

export function resolveDeepFilterAttenLimDb(value?: number): number {
    if (!Number.isFinite(value)) {
        return DEFAULT_DF_ATTEN_LIM_DB
    }
    return Math.abs(value ?? DEFAULT_DF_ATTEN_LIM_DB)
}

export function resolveDeepFilterPostFilterBeta(value?: number): number {
    if (!Number.isFinite(value)) {
        return DEFAULT_DF_POST_FILTER_BETA
    }
    return Math.max(0, value ?? DEFAULT_DF_POST_FILTER_BETA)
}

function resolveDeepFilterThreshold(value: number | undefined, defaultVal: number): number {
    return Number.isFinite(value) ? value! : defaultVal
}

export function normalizeRnnoiseConfig(config?: RnnoiseModuleConfig): ResolvedRnnoiseModuleConfig {
    return {
        vadLogs: Boolean(config?.vadLogs),
        bufferOverflowMs: resolveVadLogIntervalMs(config?.bufferOverflowMs),
    }
}

export function mergeRnnoiseConfig(
    base: ResolvedRnnoiseModuleConfig,
    patch?: RnnoiseModuleConfig,
): ResolvedRnnoiseModuleConfig {
    if (!patch) {
        return {
            ...base,
        }
    }

    return {
        vadLogs: patch.vadLogs ?? base.vadLogs,
        bufferOverflowMs:
            patch.bufferOverflowMs !== undefined
                ? resolveVadLogIntervalMs(patch.bufferOverflowMs)
                : base.bufferOverflowMs,
    }
}

export function normalizeDeepFilterConfig(
    config?: DeepFilterModuleConfig,
): ResolvedDeepFilterModuleConfig {
    return {
        attenLimDb: resolveDeepFilterAttenLimDb(config?.attenLimDb),
        postFilterBeta: resolveDeepFilterPostFilterBeta(config?.postFilterBeta),
        minDbThresh: resolveDeepFilterThreshold(config?.minDbThresh, DEFAULT_DF_MIN_DB_THRESH),
        maxDbErbThresh: resolveDeepFilterThreshold(
            config?.maxDbErbThresh,
            DEFAULT_DF_MAX_DB_ERB_THRESH,
        ),
        maxDbDfThresh: resolveDeepFilterThreshold(config?.maxDbDfThresh, DEFAULT_DF_MAX_DB_DF_THRESH),
    }
}

export function mergeDeepFilterConfig(
    base: ResolvedDeepFilterModuleConfig,
    patch?: DeepFilterModuleConfig,
): ResolvedDeepFilterModuleConfig {
    if (!patch) return { ...base }
    return {
        attenLimDb:
            patch.attenLimDb !== undefined
                ? resolveDeepFilterAttenLimDb(patch.attenLimDb)
                : base.attenLimDb,
        postFilterBeta:
            patch.postFilterBeta !== undefined
                ? resolveDeepFilterPostFilterBeta(patch.postFilterBeta)
                : base.postFilterBeta,
        minDbThresh: resolveDeepFilterThreshold(patch.minDbThresh, base.minDbThresh),
        maxDbErbThresh: resolveDeepFilterThreshold(patch.maxDbErbThresh, base.maxDbErbThresh),
        maxDbDfThresh: resolveDeepFilterThreshold(patch.maxDbDfThresh, base.maxDbDfThresh),
    }
}

export interface WorkletDeepFilterState {
    attenLimDb: number
    postFilterBeta: number
    minDbThresh: number
    maxDbErbThresh: number
    maxDbDfThresh: number
}

export function defaultWorkletDeepFilterState(): WorkletDeepFilterState {
    return {
        attenLimDb: DEFAULT_DF_ATTEN_LIM_DB,
        postFilterBeta: DEFAULT_DF_POST_FILTER_BETA,
        minDbThresh: DEFAULT_DF_MIN_DB_THRESH,
        maxDbErbThresh: DEFAULT_DF_MAX_DB_ERB_THRESH,
        maxDbDfThresh: DEFAULT_DF_MAX_DB_DF_THRESH,
    }
}

export function mergeWorkletDeepFilterState(
    base: WorkletDeepFilterState,
    patch?: {
        attenLimDb?: number
        postFilterBeta?: number
        minDbThresh?: number
        maxDbErbThresh?: number
        maxDbDfThresh?: number
    },
): WorkletDeepFilterState {
    if (!patch) return { ...base }
    return {
        attenLimDb:
            patch.attenLimDb !== undefined
                ? resolveDeepFilterAttenLimDb(patch.attenLimDb)
                : base.attenLimDb,
        postFilterBeta:
            patch.postFilterBeta !== undefined
                ? resolveDeepFilterPostFilterBeta(patch.postFilterBeta)
                : base.postFilterBeta,
        minDbThresh: resolveDeepFilterThreshold(patch.minDbThresh, base.minDbThresh),
        maxDbErbThresh: resolveDeepFilterThreshold(patch.maxDbErbThresh, base.maxDbErbThresh),
        maxDbDfThresh: resolveDeepFilterThreshold(patch.maxDbDfThresh, base.maxDbDfThresh),
    }
}

function resolveWorkletUrl(url: string): string {
    const trimmed = url.trim()
    if (trimmed.length === 0) {
        throw new Error("workletUrl is required")
    }
    return trimmed
}

function baseDir(url: string): string {
    const idx = url.lastIndexOf("/")
    return idx >= 0 ? url.substring(0, idx + 1) : "./"
}

function resolveInternalWasmUrls(workletUrl: string): InternalWasmUrls {
    const base = baseDir(workletUrl)
    return {
        rnnoise: `${base}${DEFAULT_RNNOISE_WASM_FILENAME}`,
        deepfilter: `${base}${DEFAULT_DEEPFILTER_WASM_FILENAME}`,
    }
}

export const DEFAULT_WORKER_FILENAME = "AudioPipelineWorker.js"

export function resolveWorkerUrl(workletUrl: string, workerUrl?: string): string {
    if (workerUrl?.trim()) return workerUrl.trim()
    return `${baseDir(workletUrl)}${DEFAULT_WORKER_FILENAME}`
}

export function normalizeAudioPipelineOptions(
    options: AudioPipelineOptions,
): ResolvedAudioPipelineOptions {
    const workletUrl = resolveWorkletUrl(options.workletUrl)
    return {
        workletUrl,
        workerUrl: resolveWorkerUrl(workletUrl, options.workerUrl),
        wasmUrls: resolveInternalWasmUrls(workletUrl),
        debugLogs: Boolean(options.debugLogs),
        batchFrames: Math.max(1, Math.floor(options.batchFrames ?? 1)),
        stages: {
            denoise: resolveDenoiseModule(options.stages?.denoise),
        },
        moduleConfigs: {
            rnnoise: normalizeRnnoiseConfig(options.moduleConfigs?.rnnoise),
            deepfilternet: normalizeDeepFilterConfig(options.moduleConfigs?.deepfilternet),
        },
    }
}
