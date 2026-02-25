export type PipelineStage = "denoise";
export type DenoiseModuleId = "rnnoise" | "deepfilternet";
export interface RnnoiseModuleConfig {
    vadLogs?: boolean;
    bufferOverflowMs?: number;
}
export interface DeepFilterModuleConfig {
    modelUrl?: string;
    modelBuffer?: ArrayBuffer;
    clearModel?: boolean;
    attenLimDb?: number;
    postFilterBeta?: number;
}
export interface AudioPipelineOptions {
    workletUrl: string;
    debugLogs?: boolean;
    stages?: {
        denoise?: DenoiseModuleId;
    };
    moduleConfigs?: {
        rnnoise?: RnnoiseModuleConfig;
        deepfilternet?: DeepFilterModuleConfig;
    };
}
