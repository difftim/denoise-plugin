import type { AudioPipelineOptions, DenoiseModuleId, DeepFilterModuleConfig, RnnoiseModuleConfig } from "../options";
export declare const DEFAULT_DENOISE_MODULE: DenoiseModuleId;
export declare const DEFAULT_RNNOISE_VAD_LOG_INTERVAL_MS = 1000;
export declare const DEFAULT_DF_ATTEN_LIM_DB = 100;
export declare const DEFAULT_DF_POST_FILTER_BETA = 0;
export declare const DEFAULT_DF_MIN_DB_THRESH = -15;
export declare const DEFAULT_DF_MAX_DB_ERB_THRESH = 35;
export declare const DEFAULT_DF_MAX_DB_DF_THRESH = 35;
export interface ResolvedRnnoiseModuleConfig {
    vadLogs: boolean;
    bufferOverflowMs: number;
}
export interface ResolvedDeepFilterModuleConfig {
    attenLimDb: number;
    postFilterBeta: number;
    minDbThresh: number;
    maxDbErbThresh: number;
    maxDbDfThresh: number;
}
export declare const DEFAULT_RNNOISE_WASM_FILENAME = "rnnoise.wasm";
export declare const DEFAULT_DEEPFILTER_WASM_FILENAME = "deepfilter.wasm";
export interface InternalWasmUrls {
    rnnoise: string;
    deepfilter: string;
}
export interface ResolvedAudioPipelineOptions {
    workletUrl: string;
    workerUrl: string;
    wasmUrls: InternalWasmUrls;
    debugLogs: boolean;
    batchFrames: number;
    stages: {
        denoise: DenoiseModuleId;
    };
    moduleConfigs: {
        rnnoise: ResolvedRnnoiseModuleConfig;
        deepfilternet: ResolvedDeepFilterModuleConfig;
    };
}
export declare function resolveDenoiseModule(moduleId?: DenoiseModuleId): DenoiseModuleId;
export declare function resolveDeepFilterAttenLimDb(value?: number): number;
export declare function resolveDeepFilterPostFilterBeta(value?: number): number;
export declare function normalizeRnnoiseConfig(config?: RnnoiseModuleConfig): ResolvedRnnoiseModuleConfig;
export declare function mergeRnnoiseConfig(base: ResolvedRnnoiseModuleConfig, patch?: RnnoiseModuleConfig): ResolvedRnnoiseModuleConfig;
export declare function normalizeDeepFilterConfig(config?: DeepFilterModuleConfig): ResolvedDeepFilterModuleConfig;
export declare function mergeDeepFilterConfig(base: ResolvedDeepFilterModuleConfig, patch?: DeepFilterModuleConfig): ResolvedDeepFilterModuleConfig;
export interface WorkletDeepFilterState {
    attenLimDb: number;
    postFilterBeta: number;
    minDbThresh: number;
    maxDbErbThresh: number;
    maxDbDfThresh: number;
}
export declare function defaultWorkletDeepFilterState(): WorkletDeepFilterState;
export declare function mergeWorkletDeepFilterState(base: WorkletDeepFilterState, patch?: {
    attenLimDb?: number;
    postFilterBeta?: number;
    minDbThresh?: number;
    maxDbErbThresh?: number;
    maxDbDfThresh?: number;
}): WorkletDeepFilterState;
export declare const DEFAULT_WORKER_FILENAME = "AudioPipelineWorker.js";
export declare function resolveWorkerUrl(workletUrl: string, workerUrl?: string): string;
export declare function normalizeAudioPipelineOptions(options: AudioPipelineOptions): ResolvedAudioPipelineOptions;
