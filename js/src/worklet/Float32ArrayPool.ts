export class Float32ArrayPool {
    private _pool: Float32Array[] = []
    private _size: number

    constructor(size: number, preAllocate = 128) {
        this._size = size
        for (let i = 0; i < preAllocate; i++) {
            this._pool.push(new Float32Array(size).fill(0))
        }
    }

    acquire(): Float32Array {
        const buf = this._pool.pop()
        if (buf) {
            buf.fill(0)
            return buf
        }
        return new Float32Array(this._size).fill(0)
    }

    release(buf: Float32Array): void {
        if (buf.length !== this._size) return
        if (buf.buffer.byteLength === 0) return
        this._pool.push(buf)
    }

    resize(newSize: number): void {
        if (newSize === this._size) return
        this._size = newSize
        this._pool.length = 0
    }
}
