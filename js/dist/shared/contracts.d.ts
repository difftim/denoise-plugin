import type { DenoiseModuleId, DeepFilterModuleConfig, PipelineStage, RnnoiseModuleConfig } from "../options";
export declare const COMMAND_TIMEOUT_MS = 10000;
export declare const REQUIRED_SAMPLE_RATE = 48000;
export interface WorkletRnnoiseConfigPayload extends RnnoiseModuleConfig {
}
export interface WorkletDeepFilterConfigPayload extends Omit<DeepFilterModuleConfig, "modelBuffer"> {
    modelBuffer?: ArrayBuffer;
}
export type WorkletModuleConfigPayload = WorkletRnnoiseConfigPayload | WorkletDeepFilterConfigPayload;
export interface WorkletModuleConfigPayloadMap {
    rnnoise?: WorkletRnnoiseConfigPayload;
    deepfilternet?: WorkletDeepFilterConfigPayload;
}
interface BaseMainToWorkletMessage {
    requestId?: number;
}
export interface WasmBinaries {
    rnnoiseWasm?: ArrayBuffer;
    deepfilterWasm?: ArrayBuffer;
}
export interface InitPipelineMessage extends BaseMainToWorkletMessage {
    message: "INIT_PIPELINE";
    enable?: boolean;
    debugLogs?: boolean;
    workerPort?: MessagePort;
    frameLength?: number;
    batchFrames?: number;
    stages?: {
        denoise?: DenoiseModuleId;
    };
    moduleConfigs?: WorkletModuleConfigPayloadMap;
}
export interface SetEnabledMessage extends BaseMainToWorkletMessage {
    message: "SET_ENABLED";
    enable: boolean;
}
export interface SetStageModuleMessage extends BaseMainToWorkletMessage {
    message: "SET_STAGE_MODULE";
    stage: PipelineStage;
    moduleId: DenoiseModuleId;
}
export interface SetModuleConfigMessage extends BaseMainToWorkletMessage {
    message: "SET_MODULE_CONFIG";
    moduleId: DenoiseModuleId;
    config: WorkletModuleConfigPayload;
}
export interface DestroyMessage extends BaseMainToWorkletMessage {
    message: "DESTROY";
}
export type MainToWorkletMessage = InitPipelineMessage | SetEnabledMessage | SetStageModuleMessage | SetModuleConfigMessage | DestroyMessage;
export interface CommandOkMessage {
    message: "COMMAND_OK";
    requestId?: number;
    command?: string;
}
export interface CommandErrorMessage {
    message: "COMMAND_ERROR";
    requestId?: number;
    command?: string;
    error?: string;
}
export interface LogMessage {
    message: "LOG";
    level: "info" | "error";
    tag: string;
    text: string;
    data?: unknown;
}
export type WorkletToMainMessage = CommandOkMessage | CommandErrorMessage | LogMessage;
export type RuntimeMessage = WorkletToMainMessage;
export {};
