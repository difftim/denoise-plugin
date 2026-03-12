import { DenoiseModule } from "./DenoiseModule";
export interface DeepFilterRuntimeConfig {
    attenLimDb: number;
    postFilterBeta: number;
    /** Minimum dB threshold (default -15). Below this, treat as noise only. */
    minDbThresh?: number;
    /** Max dB threshold for ERB stage (default 35). Above this, skip processing. */
    maxDbErbThresh?: number;
    /** Max dB threshold for DF stage (default 35). Above this, skip DF stage. */
    maxDbDfThresh?: number;
}
export declare function initDeepFilterWasm(wasmBinary: ArrayBuffer): void;
export declare class DeepFilterModule extends DenoiseModule<DeepFilterRuntimeConfig> {
    readonly moduleId = "deepfilternet";
    private readonly _bindings;
    private _state;
    private _frameLength;
    private _lookahead;
    private _disposed;
    constructor(config: DeepFilterRuntimeConfig, wasmBinary?: ArrayBuffer);
    get frameLength(): number;
    get lookahead(): number;
    processFrame(input: Float32Array, output: Float32Array): number | undefined;
    updateConfig(config: DeepFilterRuntimeConfig): void;
    dispose(): void;
    private _createState;
}
