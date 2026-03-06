import type { DenoiseModuleId } from "../options"
import type { WasmBinaries, WorkletModuleConfigPayloadMap } from "./contracts"

// ── Worklet → Worker ────────────────────────────────────────────

export interface WorkerInitMessage {
    type: "INIT"
    wasmBinaries: WasmBinaries
    moduleId: DenoiseModuleId
    moduleConfigs?: WorkletModuleConfigPayloadMap
    debugLogs?: boolean
}

export interface WorkerProcessFrameBatchMessage {
    type: "PROCESS_FRAME_BATCH"
    inputBuffers: Float32Array[]
    recycleBuffers?: Float32Array[]
}

export interface WorkerSetModuleMessage {
    type: "SET_MODULE"
    moduleId: DenoiseModuleId
}

export interface WorkerSetConfigMessage {
    type: "SET_CONFIG"
    moduleId: DenoiseModuleId
    config: Record<string, unknown>
}

export interface WorkerSetEnabledMessage {
    type: "SET_ENABLED"
    enable: boolean
}

export interface WorkerDestroyMessage {
    type: "DESTROY"
}

export type WorkletToWorkerMessage =
    | WorkerInitMessage
    | WorkerProcessFrameBatchMessage
    | WorkerSetModuleMessage
    | WorkerSetConfigMessage
    | WorkerSetEnabledMessage
    | WorkerDestroyMessage

// ── Worker → Worklet ────────────────────────────────────────────

export interface WorkerInitOkMessage {
    type: "INIT_OK"
    frameLength: number
    lookahead: number
}

export interface WorkerFrameResultBatchMessage {
    type: "FRAME_RESULT_BATCH"
    outputBuffers: Float32Array[]
    vadScores?: (number | undefined)[]
    recycleBuffers?: Float32Array[]
}

export interface WorkerModuleChangedMessage {
    type: "MODULE_CHANGED"
    frameLength: number
    lookahead: number
}

export interface WorkerErrorMessage {
    type: "ERROR"
    error: string
}

export interface WorkerLogMessage {
    type: "LOG"
    level: "info" | "error"
    tag: string
    text: string
    data?: unknown
}

export type WorkerToWorkletMessage =
    | WorkerInitOkMessage
    | WorkerFrameResultBatchMessage
    | WorkerModuleChangedMessage
    | WorkerErrorMessage
    | WorkerLogMessage
