import { type ResolvedDeepFilterConfig } from "../../shared/normalize";
import { AudioProcessingModule } from "./AudioProcessingModule";
export declare function initDeepFilterWasm(wasmBinary: ArrayBuffer): void;
export declare class DeepFilterModule extends AudioProcessingModule<ResolvedDeepFilterConfig> {
    readonly moduleId = "deepfilternet";
    private readonly _bindings;
    private _state;
    private _frameLength;
    private _lookahead;
    private _disposed;
    constructor(config: ResolvedDeepFilterConfig, wasmBinary?: ArrayBuffer);
    get frameLength(): number;
    get lookahead(): number;
    processFrame(input: Float32Array, output: Float32Array): number | undefined;
    updateConfig(config: ResolvedDeepFilterConfig): void;
    dispose(): void;
    private _createState;
}
