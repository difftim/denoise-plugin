export type DenoiserEngine = "rnnoise" | "deepfilternet";
export interface DeepFilterOptions {
    modelUrl?: string;
    attenLimDb?: number;
    postFilterBeta?: number;
}
export declare class DenoiseOptions {
    debugLogs?: boolean;
    vadLogs?: boolean;
    bufferOverflowMs?: number;
    workletUrl?: string;
    engine?: DenoiserEngine;
    deepFilter?: DeepFilterOptions;
}
