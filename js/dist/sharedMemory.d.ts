export declare const RNNOISE_FRAME = 480;
export declare const QUANTUM_SAMPLES = 128;
export declare const REQUIRED_SAMPLE_RATE = 48000;
export declare const SHARED_RING_CAPACITY = 65536;
export declare const RING_WRITE_INDEX = 0;
export declare const RING_READ_INDEX = 1;
export declare const RING_DROPPED_SAMPLES_INDEX = 2;
export declare const RING_STATE_LENGTH = 4;
export declare const CONTROL_SIGNAL_INDEX = 0;
export declare const CONTROL_ENABLED_INDEX = 1;
export declare const CONTROL_DESTROY_INDEX = 2;
export declare const CONTROL_WORKLET_READY_INDEX = 3;
export declare const CONTROL_WORKER_READY_INDEX = 4;
export declare const CONTROL_RING_CAPACITY_INDEX = 5;
export declare const CONTROL_STATE_LENGTH = 8;
export interface SharedBufferPayload {
    inputState: SharedArrayBuffer;
    inputData: SharedArrayBuffer;
    outputState: SharedArrayBuffer;
    outputData: SharedArrayBuffer;
    controlState: SharedArrayBuffer;
}
export interface SharedRingBufferView {
    readonly state: Int32Array;
    readonly data: Float32Array;
    readonly capacity: number;
}
export interface SharedRingPushResult {
    written: number;
    dropped: number;
}
export declare function createSharedBufferPayload(capacity?: number): SharedBufferPayload;
export declare function createSharedRingBufferView(stateBuffer: SharedArrayBuffer, dataBuffer: SharedArrayBuffer): SharedRingBufferView;
export declare function getSharedRingAvailableFrames(view: SharedRingBufferView): number;
export declare function pushToSharedRing(view: SharedRingBufferView, input: Float32Array): SharedRingPushResult;
export declare function pullFromSharedRing(view: SharedRingBufferView, target: Float32Array): boolean;
export declare function clearSharedRing(view: SharedRingBufferView): void;
