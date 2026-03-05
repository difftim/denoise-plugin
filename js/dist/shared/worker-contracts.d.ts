import type { DenoiseModuleId } from "../options";
import type { WasmBinaries, WorkletModuleConfigPayloadMap } from "./contracts";
export interface WorkerInitMessage {
    type: "INIT";
    wasmBinaries: WasmBinaries;
    moduleId: DenoiseModuleId;
    moduleConfigs?: WorkletModuleConfigPayloadMap;
    debugLogs?: boolean;
}
export interface WorkerProcessFrameMessage {
    type: "PROCESS_FRAME";
    inputBuffer: Float32Array;
}
export interface WorkerSetModuleMessage {
    type: "SET_MODULE";
    moduleId: DenoiseModuleId;
    config?: WorkletModuleConfigPayloadMap;
}
export interface WorkerSetConfigMessage {
    type: "SET_CONFIG";
    moduleId: DenoiseModuleId;
    config: Record<string, unknown>;
}
export interface WorkerSetEnabledMessage {
    type: "SET_ENABLED";
    enable: boolean;
}
export interface WorkerDestroyMessage {
    type: "DESTROY";
}
export type WorkletToWorkerMessage = WorkerInitMessage | WorkerProcessFrameMessage | WorkerSetModuleMessage | WorkerSetConfigMessage | WorkerSetEnabledMessage | WorkerDestroyMessage;
export interface WorkerInitOkMessage {
    type: "INIT_OK";
    frameLength: number;
    lookahead: number;
}
export interface WorkerFrameResultMessage {
    type: "FRAME_RESULT";
    outputBuffer: Float32Array;
    vadScore?: number;
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
export interface WorkerLogMessage {
    type: "LOG";
    level: "info" | "error";
    tag: string;
    text: string;
    data?: unknown;
}
export type WorkerToWorkletMessage = WorkerInitOkMessage | WorkerFrameResultMessage | WorkerModuleChangedMessage | WorkerErrorMessage | WorkerLogMessage;
