import type { AudioPipelineOptions, DenoiseModuleId, DeepFilterModuleConfig, RnnoiseModuleConfig } from "../options";
export declare const DEFAULT_DENOISE_MODULE: DenoiseModuleId;
export declare const DEFAULT_RNNOISE_VAD_LOG_INTERVAL_MS = 1000;
export declare const DEFAULT_DF_ATTEN_LIM_DB = 100;
export declare const DEFAULT_DF_POST_FILTER_BETA = 0;
export interface ResolvedRnnoiseModuleConfig {
    vadLogs: boolean;
    bufferOverflowMs: number;
}
export interface ResolvedDeepFilterModuleConfig {
    modelUrl?: string;
    modelBuffer?: ArrayBuffer;
    attenLimDb: number;
    postFilterBeta: number;
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
    stages: {
        denoise: DenoiseModuleId;
    };
    moduleConfigs: {
        rnnoise: ResolvedRnnoiseModuleConfig;
        deepfilternet: ResolvedDeepFilterModuleConfig;
    };
}
export declare function cloneArrayBuffer(buffer: ArrayBuffer): ArrayBuffer;
export declare function cloneBytes(bytes?: Uint8Array): Uint8Array | undefined;
export declare function normalizeModelUrl(value?: string): string | undefined;
export declare function resolveDenoiseModule(moduleId?: DenoiseModuleId): DenoiseModuleId;
export declare function resolveDeepFilterAttenLimDb(value?: number): number;
export declare function resolveDeepFilterPostFilterBeta(value?: number): number;
export declare function normalizeRnnoiseConfig(config?: RnnoiseModuleConfig): ResolvedRnnoiseModuleConfig;
export declare function mergeRnnoiseConfig(base: ResolvedRnnoiseModuleConfig, patch?: RnnoiseModuleConfig): ResolvedRnnoiseModuleConfig;
export declare function normalizeDeepFilterConfig(config?: DeepFilterModuleConfig): ResolvedDeepFilterModuleConfig;
export declare function mergeDeepFilterConfig(base: ResolvedDeepFilterModuleConfig, patch?: DeepFilterModuleConfig): ResolvedDeepFilterModuleConfig;
export interface WorkletDeepFilterState {
    modelUrl?: string;
    modelBytes?: Uint8Array;
    attenLimDb: number;
    postFilterBeta: number;
}
export declare function defaultWorkletDeepFilterState(): WorkletDeepFilterState;
export declare function mergeWorkletDeepFilterState(base: WorkletDeepFilterState, patch?: {
    modelUrl?: string;
    modelBuffer?: ArrayBuffer;
    clearModel?: boolean;
    attenLimDb?: number;
    postFilterBeta?: number;
}): WorkletDeepFilterState;
export declare const DEFAULT_WORKER_FILENAME = "AudioPipelineWorker.js";
export declare function resolveWorkerUrl(workletUrl: string, workerUrl?: string): string;
export declare function normalizeAudioPipelineOptions(options: AudioPipelineOptions): ResolvedAudioPipelineOptions;
