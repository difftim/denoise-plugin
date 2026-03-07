export class MonoRingBuffer {
    private readonly _data: Float32Array
    private _readIndex = 0
    private _writeIndex = 0
    private _framesAvailable = 0

    constructor(capacity: number) {
        this._data = new Float32Array(capacity).fill(0)
    }

    get framesAvailable(): number {
        return this._framesAvailable
    }

    get capacity(): number {
        return this._data.length
    }

    push(input: Float32Array): void {
        const cap = this._data.length
        const len = input.length
        if (len === 0) return

        const tail = cap - this._writeIndex

        if (len <= tail) {
            this._data.set(input, this._writeIndex)
        } else {
            this._data.set(input.subarray(0, tail), this._writeIndex)
            this._data.set(input.subarray(tail), 0)
        }

        this._writeIndex = (this._writeIndex + len) % cap
        this._framesAvailable = Math.min(this._framesAvailable + len, cap)
    }

    pull(target: Float32Array): boolean {
        const len = target.length
        if (this._framesAvailable < len) {
            target.fill(0)
            return false
        }

        const cap = this._data.length
        const tail = cap - this._readIndex

        if (len <= tail) {
            target.set(this._data.subarray(this._readIndex, this._readIndex + len))
        } else {
            target.set(this._data.subarray(this._readIndex, cap))
            target.set(this._data.subarray(0, len - tail), tail)
        }

        this._readIndex = (this._readIndex + len) % cap
        this._framesAvailable -= len
        return true
    }

    drainInto(dest: MonoRingBuffer): void {
        const count = this._framesAvailable
        if (count === 0) {
            return
        }

        const cap = this._data.length
        const tail = cap - this._readIndex

        if (count <= tail) {
            dest.push(this._data.subarray(this._readIndex, this._readIndex + count))
        } else {
            dest.push(this._data.subarray(this._readIndex, cap))
            dest.push(this._data.subarray(0, count - tail))
        }

        this._readIndex = (this._readIndex + count) % cap
        this._framesAvailable = 0
    }

    clear(): void {
        this._readIndex = 0
        this._writeIndex = 0
        this._framesAvailable = 0
        this._data.fill(0)
    }
}
