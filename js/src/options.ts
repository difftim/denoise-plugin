export type DenoiserEngine = "rnnoise" | "deepfilternet"

export interface DeepFilterOptions {
    jsUrl?: string
    wasmUrl?: string
    modelUrl?: string
    attenLimDb?: number
    postFilterBeta?: number
}

export class DenoiseOptions {
    debugLogs?: boolean
    vadLogs?: boolean
    bufferOverflowMs?: number
    workletUrl?: string
    workerUrl?: string
    engine?: DenoiserEngine
    deepFilter?: DeepFilterOptions
}
