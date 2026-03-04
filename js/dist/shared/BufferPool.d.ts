export declare class BufferPool {
    private _pool;
    private readonly _frameSize;
    constructor(frameSize: number, preAllocate?: number);
    acquire(): Float32Array;
    release(buffer: Float32Array): void;
    resize(newFrameSize: number): BufferPool;
}
