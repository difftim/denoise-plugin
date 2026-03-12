import type { DenoiseModuleId, PipelineStage } from "../options";
import type { ResolvedDeepFilterConfig, ResolvedRnnoiseModuleConfig } from "./normalize";
export declare const COMMAND_TIMEOUT_MS = 10000;
export interface WorkletModuleConfigPayloadMap {
    rnnoise?: ResolvedRnnoiseModuleConfig;
    deepfilternet?: ResolvedDeepFilterConfig;
}
interface BaseMainToWorkletMessage {
    requestId?: number;
}
export interface WasmBinaries {
    rnnoiseWasm?: ArrayBuffer;
    deepfilterWasm?: ArrayBuffer;
}
export interface InitPipelineMessage extends BaseMainToWorkletMessage {
    type: "INIT_PIPELINE";
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
    type: "SET_ENABLED";
    enable: boolean;
}
export interface SetStageModuleMessage extends BaseMainToWorkletMessage {
    type: "SET_STAGE_MODULE";
    stage: PipelineStage;
    moduleId: DenoiseModuleId;
}
export type SetModuleConfigMessage = (BaseMainToWorkletMessage & {
    type: "SET_MODULE_CONFIG";
    moduleId: "rnnoise";
    config: ResolvedRnnoiseModuleConfig;
}) | (BaseMainToWorkletMessage & {
    type: "SET_MODULE_CONFIG";
    moduleId: "deepfilternet";
    config: ResolvedDeepFilterConfig;
});
export interface DestroyMessage extends BaseMainToWorkletMessage {
    type: "DESTROY";
}
export type MainToWorkletMessage = InitPipelineMessage | SetEnabledMessage | SetStageModuleMessage | SetModuleConfigMessage | DestroyMessage;
export interface CommandOkMessage {
    type: "COMMAND_OK";
    requestId?: number;
    command?: string;
}
export interface CommandErrorMessage {
    type: "COMMAND_ERROR";
    requestId?: number;
    command?: string;
    error?: string;
}
export interface LogMessage {
    type: "LOG";
    level: "info" | "error";
    tag: string;
    text: string;
    data?: unknown;
}
export type WorkletToMainMessage = CommandOkMessage | CommandErrorMessage | LogMessage;
export type RuntimeMessage = WorkletToMainMessage;
export {};
