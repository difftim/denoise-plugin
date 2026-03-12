import type { DenoiseModuleId } from "../options";
import type { LogMessage, WasmBinaries, WorkletModuleConfigPayloadMap } from "./contracts";
import type { ResolvedDeepFilterConfig, ResolvedRnnoiseModuleConfig } from "./normalize";
export interface WorkerInitMessage {
    type: "INIT";
    wasmBinaries: WasmBinaries;
    moduleId: DenoiseModuleId;
    moduleConfigs?: WorkletModuleConfigPayloadMap;
    debugLogs?: boolean;
}
export interface WorkerProcessFrameBatchMessage {
    type: "PROCESS_FRAME_BATCH";
    inputBuffers: Float32Array[];
    recycleBuffers?: Float32Array[];
}
export interface WorkerSetModuleMessage {
    type: "SET_MODULE";
    moduleId: DenoiseModuleId;
}
export type WorkerSetModuleConfigMessage = {
    type: "SET_MODULE_CONFIG";
    moduleId: "rnnoise";
    config: ResolvedRnnoiseModuleConfig;
} | {
    type: "SET_MODULE_CONFIG";
    moduleId: "deepfilternet";
    config: ResolvedDeepFilterConfig;
};
export interface WorkerSetEnabledMessage {
    type: "SET_ENABLED";
    enable: boolean;
}
export interface WorkerDestroyMessage {
    type: "DESTROY";
}
export type WorkletToWorkerMessage = WorkerInitMessage | WorkerProcessFrameBatchMessage | WorkerSetModuleMessage | WorkerSetModuleConfigMessage | WorkerSetEnabledMessage | WorkerDestroyMessage;
export interface WorkerInitOkMessage {
    type: "INIT_OK";
    frameLength: number;
    lookahead: number;
}
export interface WorkerFrameResultBatchMessage {
    type: "FRAME_RESULT_BATCH";
    outputBuffers: Float32Array[];
    vadScores?: (number | undefined)[];
    recycleBuffers?: Float32Array[];
}
export interface WorkerModuleChangedMessage {
    type: "MODULE_CHANGED";
    frameLength: number;
    lookahead: number;
}
export interface WorkerErrorMessage {
    type: "ERROR";
    error: string;
}
export type WorkerToWorkletMessage = WorkerInitOkMessage | WorkerFrameResultBatchMessage | WorkerModuleChangedMessage | WorkerErrorMessage | LogMessage;
