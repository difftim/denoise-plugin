export class BufferPool {
    private _pool: Float32Array[] = []
    private readonly _frameSize: number

    constructor(frameSize: number, preAllocate = 8) {
        this._frameSize = frameSize
        for (let i = 0; i < preAllocate; i++) {
            this._pool.push(new Float32Array(frameSize))
        }
    }

    acquire(): Float32Array {
        return this._pool.pop() ?? new Float32Array(this._frameSize)
    }

    release(buffer: Float32Array): void {
        if (buffer.length !== this._frameSize) return
        if (buffer.buffer.byteLength === 0) return
        this._pool.push(buffer)
    }

    resize(newFrameSize: number): BufferPool {
        if (newFrameSize === this._frameSize) return this
        return new BufferPool(newFrameSize, this._pool.length || 8)
    }
}
