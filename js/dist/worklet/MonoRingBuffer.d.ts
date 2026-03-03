export declare class MonoRingBuffer {
    private readonly _data;
    private _readIndex;
    private _writeIndex;
    private _framesAvailable;
    constructor(capacity: number);
    get framesAvailable(): number;
    get capacity(): number;
    push(input: Float32Array): void;
    pull(target: Float32Array): boolean;
    drainInto(dest: MonoRingBuffer): void;
    clear(): void;
}
