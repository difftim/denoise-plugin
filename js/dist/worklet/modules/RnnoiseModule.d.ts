import type { ResolvedRnnoiseModuleConfig } from "../../shared/normalize";
import { DenoiseModule } from "./DenoiseModule";
export declare class RnnoiseModule extends DenoiseModule<ResolvedRnnoiseModuleConfig> {
    readonly moduleId = "rnnoise";
    readonly frameLength = 480;
    private readonly _module;
    private readonly _context;
    private readonly _inputPtr;
    private readonly _outputPtr;
    private readonly _inputHeap;
    private readonly _outputHeap;
    private _disposed;
    constructor(config: ResolvedRnnoiseModuleConfig);
    processFrame(input: Float32Array, output: Float32Array): number;
    updateConfig(config: ResolvedRnnoiseModuleConfig): void;
    dispose(): void;
}
