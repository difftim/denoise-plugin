export declare abstract class AudioProcessingModule<TConfig> {
    protected _config: TConfig;
    protected constructor(config: TConfig);
    abstract readonly moduleId: string;
    abstract get frameLength(): number;
    abstract processFrame(input: Float32Array, output: Float32Array): number | undefined;
    abstract updateConfig(config: TConfig): void;
    abstract dispose(): void;
}
