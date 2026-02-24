export const RNNOISE_FRAME = 480
export const QUANTUM_SAMPLES = 128
export const REQUIRED_SAMPLE_RATE = 48000

export const SHARED_RING_CAPACITY = 65536

export const RING_WRITE_INDEX = 0
export const RING_READ_INDEX = 1
export const RING_DROPPED_SAMPLES_INDEX = 2
export const RING_STATE_LENGTH = 4

export const CONTROL_SIGNAL_INDEX = 0
export const CONTROL_ENABLED_INDEX = 1
export const CONTROL_DESTROY_INDEX = 2
export const CONTROL_WORKLET_READY_INDEX = 3
export const CONTROL_WORKER_READY_INDEX = 4
export const CONTROL_RING_CAPACITY_INDEX = 5
export const CONTROL_STATE_LENGTH = 8

export interface SharedBufferPayload {
    inputState: SharedArrayBuffer
    inputData: SharedArrayBuffer
    outputState: SharedArrayBuffer
    outputData: SharedArrayBuffer
    controlState: SharedArrayBuffer
}

export interface SharedRingBufferView {
    readonly state: Int32Array
    readonly data: Float32Array
    readonly capacity: number
}

export interface SharedRingPushResult {
    written: number
    dropped: number
}

export function createSharedBufferPayload(capacity = SHARED_RING_CAPACITY): SharedBufferPayload {
    if (capacity <= 0) {
        throw new Error("Shared ring capacity must be greater than 0")
    }

    const inputState = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * RING_STATE_LENGTH)
    const inputData = new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * capacity)
    const outputState = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * RING_STATE_LENGTH)
    const outputData = new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * capacity)
    const controlState = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * CONTROL_STATE_LENGTH)

    const control = new Int32Array(controlState)
    Atomics.store(control, CONTROL_RING_CAPACITY_INDEX, capacity)

    return {
        inputState,
        inputData,
        outputState,
        outputData,
        controlState,
    }
}

export function createSharedRingBufferView(
    stateBuffer: SharedArrayBuffer,
    dataBuffer: SharedArrayBuffer,
): SharedRingBufferView {
    const state = new Int32Array(stateBuffer)
    const data = new Float32Array(dataBuffer)

    if (state.length < RING_STATE_LENGTH) {
        throw new Error(`Invalid shared ring state length: expected >=${RING_STATE_LENGTH}`)
    }
    if (data.length <= 0) {
        throw new Error("Invalid shared ring data length")
    }

    return {
        state,
        data,
        capacity: data.length,
    }
}

export function getSharedRingAvailableFrames(view: SharedRingBufferView): number {
    const write = Atomics.load(view.state, RING_WRITE_INDEX) >>> 0
    const read = Atomics.load(view.state, RING_READ_INDEX) >>> 0
    const rawUsed = (write - read) >>> 0

    if (rawUsed <= view.capacity) {
        return rawUsed
    }

    // Recover from inconsistent indices by clamping to full buffer usage.
    const recoveredRead = (write - view.capacity) >>> 0
    Atomics.store(view.state, RING_READ_INDEX, recoveredRead | 0)
    return view.capacity
}

export function pushToSharedRing(
    view: SharedRingBufferView,
    input: Float32Array,
): SharedRingPushResult {
    if (input.length === 0) {
        return { written: 0, dropped: 0 }
    }

    const write = Atomics.load(view.state, RING_WRITE_INDEX) >>> 0
    const used = getSharedRingAvailableFrames(view)
    const free = Math.max(0, view.capacity - used)
    const written = Math.min(free, input.length)
    const dropped = input.length - written

    if (written > 0) {
        writeWrapped(view.data, write % view.capacity, input, written)
        Atomics.store(view.state, RING_WRITE_INDEX, ((write + written) >>> 0) | 0)
    }

    if (dropped > 0) {
        Atomics.add(view.state, RING_DROPPED_SAMPLES_INDEX, dropped)
    }

    return { written, dropped }
}

export function pullFromSharedRing(view: SharedRingBufferView, target: Float32Array): boolean {
    if (target.length === 0) {
        return true
    }

    const read = Atomics.load(view.state, RING_READ_INDEX) >>> 0
    const available = getSharedRingAvailableFrames(view)
    if (available < target.length) {
        return false
    }

    readWrapped(view.data, read % view.capacity, target, target.length)
    Atomics.store(view.state, RING_READ_INDEX, ((read + target.length) >>> 0) | 0)
    return true
}

export function clearSharedRing(view: SharedRingBufferView): void {
    const write = Atomics.load(view.state, RING_WRITE_INDEX) >>> 0
    Atomics.store(view.state, RING_READ_INDEX, write | 0)
}

function writeWrapped(
    destination: Float32Array,
    startIndex: number,
    source: Float32Array,
    length: number,
): void {
    const firstLength = Math.min(length, destination.length - startIndex)
    destination.set(source.subarray(0, firstLength), startIndex)

    const remaining = length - firstLength
    if (remaining > 0) {
        destination.set(source.subarray(firstLength, firstLength + remaining), 0)
    }
}

function readWrapped(
    source: Float32Array,
    startIndex: number,
    destination: Float32Array,
    length: number,
): void {
    const firstLength = Math.min(length, source.length - startIndex)
    destination.set(source.subarray(startIndex, startIndex + firstLength), 0)

    const remaining = length - firstLength
    if (remaining > 0) {
        destination.set(source.subarray(0, remaining), firstLength)
    }
}
