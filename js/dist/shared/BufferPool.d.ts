export interface BufferPoolStats {
    poolSize: number;
    frameSize: number;
    hits: number;
    misses: number;
    total: number;
    hitRate: string;
}
export declare class BufferPool {
    private _pool;
    private readonly _frameSize;
    private _hits;
    private _misses;
    constructor(frameSize: number, preAllocate?: number);
    acquire(): Float32Array;
    release(buffer: Float32Array): void;
    resize(newFrameSize: number): BufferPool;
    stats(): BufferPoolStats;
    resetStats(): void;
}
