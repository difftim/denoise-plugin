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

export interface ResolvedRnnoiseModuleConfig {
    vadLogs: boolean
    bufferOverflowMs: number
}

export interface ResolvedDeepFilterModuleConfig {
    modelUrl?: string
    modelBuffer?: ArrayBuffer
    attenLimDb: number
    postFilterBeta: number
}

export interface ResolvedAudioPipelineOptions {
    workletUrl: string
    debugLogs: boolean
    stages: {
        denoise: DenoiseModuleId
    }
    moduleConfigs: {
        rnnoise: ResolvedRnnoiseModuleConfig
        deepfilternet: ResolvedDeepFilterModuleConfig
    }
}

export function cloneArrayBuffer(buffer: ArrayBuffer): ArrayBuffer {
    return buffer.slice(0)
}

export function cloneBytes(bytes?: Uint8Array): Uint8Array | undefined {
    return bytes ? bytes.slice(0) : undefined
}

export function sameBytes(left?: Uint8Array, right?: Uint8Array): boolean {
    if (left === right) return true
    if (!left || !right) return false
    if (left.byteLength !== right.byteLength) return false

    for (let i = 0; i < left.byteLength; i += 1) {
        if (left[i] !== right[i]) return false
    }
    return true
}

export function normalizeModelUrl(value?: string): string | undefined {
    if (typeof value !== "string") {
        return undefined
    }

    const trimmed = value.trim()
    if (trimmed.length === 0) {
        return undefined
    }

    return trimmed
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
        modelUrl: normalizeModelUrl(config?.modelUrl),
        modelBuffer:
            config?.modelBuffer !== undefined ? cloneArrayBuffer(config.modelBuffer) : undefined,
        attenLimDb: resolveDeepFilterAttenLimDb(config?.attenLimDb),
        postFilterBeta: resolveDeepFilterPostFilterBeta(config?.postFilterBeta),
    }
}

export function mergeDeepFilterConfig(
    base: ResolvedDeepFilterModuleConfig,
    patch?: DeepFilterModuleConfig,
): ResolvedDeepFilterModuleConfig {
    if (!patch) {
        return {
            ...base,
            modelBuffer: base.modelBuffer ? cloneArrayBuffer(base.modelBuffer) : undefined,
        }
    }

    let modelUrl = base.modelUrl
    let modelBuffer = base.modelBuffer ? cloneArrayBuffer(base.modelBuffer) : undefined

    if (patch.clearModel === true) {
        modelUrl = undefined
        modelBuffer = undefined
    }

    if (patch.modelUrl !== undefined) {
        modelUrl = normalizeModelUrl(patch.modelUrl)
        modelBuffer = undefined
    }

    if (patch.modelBuffer !== undefined) {
        modelBuffer = cloneArrayBuffer(patch.modelBuffer)
    }

    return {
        modelUrl,
        modelBuffer,
        attenLimDb:
            patch.attenLimDb !== undefined
                ? resolveDeepFilterAttenLimDb(patch.attenLimDb)
                : base.attenLimDb,
        postFilterBeta:
            patch.postFilterBeta !== undefined
                ? resolveDeepFilterPostFilterBeta(patch.postFilterBeta)
                : base.postFilterBeta,
    }
}

export interface WorkletDeepFilterState {
    modelUrl?: string
    modelBytes?: Uint8Array
    attenLimDb: number
    postFilterBeta: number
}

export function defaultWorkletDeepFilterState(): WorkletDeepFilterState {
    return {
        modelUrl: undefined,
        modelBytes: undefined,
        attenLimDb: DEFAULT_DF_ATTEN_LIM_DB,
        postFilterBeta: DEFAULT_DF_POST_FILTER_BETA,
    }
}

export function mergeWorkletDeepFilterState(
    base: WorkletDeepFilterState,
    patch?: {
        modelUrl?: string
        modelBuffer?: ArrayBuffer
        clearModel?: boolean
        attenLimDb?: number
        postFilterBeta?: number
    },
): WorkletDeepFilterState {
    if (!patch) return { ...base, modelBytes: cloneBytes(base.modelBytes) }

    let modelUrl = normalizeModelUrl(base.modelUrl)
    let modelBytes = cloneBytes(base.modelBytes)

    if (patch.clearModel === true) {
        modelUrl = undefined
        modelBytes = undefined
    }
    if (patch.modelUrl !== undefined) {
        modelUrl = normalizeModelUrl(patch.modelUrl)
        modelBytes = undefined
    }
    if (patch.modelBuffer !== undefined) {
        if (patch.modelBuffer.byteLength <= 0) {
            throw new Error("DeepFilter modelBuffer is empty")
        }
        modelBytes = new Uint8Array(patch.modelBuffer.slice(0))
    }

    return {
        modelUrl,
        modelBytes,
        attenLimDb:
            patch.attenLimDb !== undefined
                ? resolveDeepFilterAttenLimDb(patch.attenLimDb)
                : base.attenLimDb,
        postFilterBeta:
            patch.postFilterBeta !== undefined
                ? resolveDeepFilterPostFilterBeta(patch.postFilterBeta)
                : base.postFilterBeta,
    }
}

function resolveWorkletUrl(url: string): string {
    const trimmed = url.trim()
    if (trimmed.length === 0) {
        throw new Error("workletUrl is required")
    }
    return trimmed
}

export function normalizeAudioPipelineOptions(
    options: AudioPipelineOptions,
): ResolvedAudioPipelineOptions {
    return {
        workletUrl: resolveWorkletUrl(options.workletUrl),
        debugLogs: Boolean(options.debugLogs),
        stages: {
            denoise: resolveDenoiseModule(options.stages?.denoise),
        },
        moduleConfigs: {
            rnnoise: normalizeRnnoiseConfig(options.moduleConfigs?.rnnoise),
            deepfilternet: normalizeDeepFilterConfig(options.moduleConfigs?.deepfilternet),
        },
    }
}
