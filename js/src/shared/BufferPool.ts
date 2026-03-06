export interface BufferPoolStats {
    poolSize: number
    frameSize: number
    hits: number
    misses: number
    total: number
    hitRate: string
}

export class BufferPool {
    private _pool: Float32Array[] = []
    private readonly _frameSize: number
    private _hits = 0
    private _misses = 0

    constructor(frameSize: number, preAllocate = 32) {
        this._frameSize = frameSize
        for (let i = 0; i < preAllocate; i++) {
            this._pool.push(new Float32Array(frameSize))
        }
    }

    acquire(): Float32Array {
        const buf = this._pool.pop()
        if (buf) {
            this._hits++
            buf.fill(0)
            return buf
        }
        this._misses++
        return new Float32Array(this._frameSize)
    }

    release(buffer: Float32Array): void {
        if (buffer.length !== this._frameSize) return
        if (buffer.buffer.byteLength === 0) return
        this._pool.push(buffer)
    }

    resize(newFrameSize: number): BufferPool {
        if (newFrameSize === this._frameSize) return this
        return new BufferPool(newFrameSize, this._pool.length || 32)
    }

    stats(): BufferPoolStats {
        const total = this._hits + this._misses
        return {
            poolSize: this._pool.length,
            frameSize: this._frameSize,
            hits: this._hits,
            misses: this._misses,
            total,
            hitRate: total > 0 ? `${((this._hits / total) * 100).toFixed(1)}%` : "N/A",
        }
    }

    resetStats(): void {
        this._hits = 0
        this._misses = 0
    }
}
