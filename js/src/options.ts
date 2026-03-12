export type PipelineStage = "denoise"

export type DenoiseModuleId = "rnnoise" | "deepfilternet"

export interface RnnoiseModuleConfig {
    vadLogs?: boolean
    bufferOverflowMs?: number
}

export interface DeepFilterModuleConfig {
    attenLimDb?: number
    postFilterBeta?: number
    /** Minimum dB threshold (default -15). Below this, treat as noise only. */
    minDbThresh?: number
    /** Max dB threshold for ERB stage (default 35). Above this, skip processing. */
    maxDbErbThresh?: number
    /** Max dB threshold for DF stage (default 35). Above this, skip DF stage. */
    maxDbDfThresh?: number
}

export interface AudioPipelineOptions {
    workletUrl: string
    workerUrl?: string
    debugLogs?: boolean
    batchFrames?: number
    stages?: {
        denoise?: DenoiseModuleId
    }
    moduleConfigs?: {
        rnnoise?: RnnoiseModuleConfig
        deepfilternet?: DeepFilterModuleConfig
    }
}
