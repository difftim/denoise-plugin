export declare class Float32ArrayPool {
    private _pool;
    private _size;
    constructor(size: number, preAllocate?: number);
    acquire(): Float32Array;
    release(buf: Float32Array): void;
    resize(newSize: number): void;
}
