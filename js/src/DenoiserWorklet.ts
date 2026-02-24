import {
    CONTROL_DESTROY_INDEX,
    CONTROL_ENABLED_INDEX,
    CONTROL_SIGNAL_INDEX,
    CONTROL_WORKER_READY_INDEX,
    CONTROL_WORKLET_READY_INDEX,
    SharedBufferPayload,
    SharedRingBufferView,
    clearSharedRing,
    createSharedRingBufferView,
    pullFromSharedRing,
    pushToSharedRing,
} from "./sharedMemory"

const STARTUP_GRACE_BLOCKS = 6
const MAX_CONSECUTIVE_UNDERFLOW_BLOCKS = 4
const UNDERFLOW_FATAL_MIN_DURATION_MS = 500

interface MainToWorkletMessage {
    message: string
    enable?: boolean
    sharedBuffers?: SharedBufferPayload
}

class DenoiserWorklet extends AudioWorkletProcessor {
    private _debugLogs = false
    private _destroyed = false
    private _shouldDenoise = true

    private _sharedInput?: SharedRingBufferView
    private _sharedOutput?: SharedRingBufferView
    private _sharedControl?: Int32Array
    private _sharedReady = false

    private _startupGraceBlocksRemaining = STARTUP_GRACE_BLOCKS
    private _consecutiveUnderflowBlocks = 0
    private _underflowStreakStartMs = 0

    constructor(options: { processorOptions?: { debugLogs?: boolean } }) {
        super()
        this._debugLogs = options.processorOptions?.debugLogs ?? false
        this._handleControlMessages()

        if (this._debugLogs) {
            this._postMainMessage({ message: "DENOISER_WORKLET_INIT" })
        }
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        const processStartMs = this._nowMs()
        let inputFrames = 0
        let inputDurationMs = 0

        try {
            if (this._destroyed) {
                return false
            }

            const input = inputs[0]
            const output = outputs[0]
            const inputMono = input?.[0]
            inputFrames = inputMono?.length ?? 0
            inputDurationMs = this._framesToMs(inputFrames)

            if (!inputMono || !output?.[0]) {
                return true
            }

            if (
                !this._sharedReady ||
                !this._sharedInput ||
                !this._sharedOutput ||
                !this._sharedControl
            ) {
                this._copyMonoToOutput(inputMono, output)
                return true
            }

            if (Atomics.load(this._sharedControl, CONTROL_DESTROY_INDEX) === 1) {
                this.destroy()
                return false
            }

            if (!this._shouldDenoise) {
                this._copyMonoToOutput(inputMono, output)
                return true
            }

            if (Atomics.load(this._sharedControl, CONTROL_WORKER_READY_INDEX) !== 1) {
                this._resetFlowState()
                this._copyMonoToOutput(inputMono, output)
                return true
            }

            pushToSharedRing(this._sharedInput, inputMono)
            Atomics.add(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)
            Atomics.notify(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)

            const pulled = pullFromSharedRing(this._sharedOutput, output[0])
            if (pulled) {
                for (let channel = 1; channel < output.length; channel += 1) {
                    output[channel].set(output[0])
                }

                this._consecutiveUnderflowBlocks = 0
                this._underflowStreakStartMs = 0
                return true
            }

            this._copyMonoToOutput(inputMono, output)

            if (this._startupGraceBlocksRemaining > 0) {
                this._startupGraceBlocksRemaining -= 1
                return true
            }

            const nowMs = this._nowMs()
            if (this._consecutiveUnderflowBlocks === 0) {
                this._underflowStreakStartMs = nowMs
            }

            this._consecutiveUnderflowBlocks += 1
            const underflowDurationMs =
                this._underflowStreakStartMs > 0 ? nowMs - this._underflowStreakStartMs : 0
            if (
                this._consecutiveUnderflowBlocks >= MAX_CONSECUTIVE_UNDERFLOW_BLOCKS &&
                underflowDurationMs >= UNDERFLOW_FATAL_MIN_DURATION_MS
            ) {
                this._postMainMessage({
                    message: "DENOISER_WORKER_ERROR",
                    error: "Worker output underflow threshold exceeded",
                })
                this.destroy()
                return false
            }

            return true
        } finally {
            this._maybeLogProcessOverrun(processStartMs, inputDurationMs, inputFrames)
        }
    }

    private _handleControlMessages() {
        this.port.onmessage = (event: MessageEvent<MainToWorkletMessage>) => {
            const payload = event.data
            if (!payload?.message) {
                return
            }

            switch (payload.message) {
                case "ATTACH_SHARED_BUFFERS": {
                    if (payload.sharedBuffers) {
                        this._attachSharedBuffers(payload.sharedBuffers)
                    }
                    break
                }
                case "SET_ENABLED": {
                    this._setEnabled(payload.enable ?? this._shouldDenoise)
                    break
                }
                case "DESTORY": {
                    this.destroy()
                    break
                }
                default:
                    break
            }
        }
    }

    private _attachSharedBuffers(sharedBuffers: SharedBufferPayload) {
        this._sharedInput = createSharedRingBufferView(
            sharedBuffers.inputState,
            sharedBuffers.inputData,
        )
        this._sharedOutput = createSharedRingBufferView(
            sharedBuffers.outputState,
            sharedBuffers.outputData,
        )
        this._sharedControl = new Int32Array(sharedBuffers.controlState)

        this._sharedReady = true
        Atomics.store(this._sharedControl, CONTROL_WORKLET_READY_INDEX, 1)
        Atomics.store(this._sharedControl, CONTROL_ENABLED_INDEX, this._shouldDenoise ? 1 : 0)
        this._resetFlowState()

        Atomics.add(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)
        Atomics.notify(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)

        if (this._debugLogs) {
            this._postMainMessage({ message: "DENOISER_WORKLET_BUFFERS_ATTACHED" })
        }
    }

    private _setEnabled(enable: boolean) {
        this._shouldDenoise = enable

        if (this._sharedInput && this._sharedOutput && this._sharedControl) {
            clearSharedRing(this._sharedInput)
            clearSharedRing(this._sharedOutput)
            Atomics.store(this._sharedControl, CONTROL_ENABLED_INDEX, enable ? 1 : 0)
            Atomics.add(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)
            Atomics.notify(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)
        }

        this._resetFlowState()

        if (this._debugLogs) {
            this._postMainMessage({
                message: enable ? "DENOISER_WORKLET_ENABLED" : "DENOISER_WORKLET_DISABLED",
            })
        }
    }

    private _resetFlowState() {
        this._startupGraceBlocksRemaining = STARTUP_GRACE_BLOCKS
        this._consecutiveUnderflowBlocks = 0
        this._underflowStreakStartMs = 0
    }

    destroy() {
        if (this._destroyed) {
            return
        }

        this._destroyed = true
        if (this._sharedControl) {
            Atomics.store(this._sharedControl, CONTROL_DESTROY_INDEX, 1)
            Atomics.add(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)
            Atomics.notify(this._sharedControl, CONTROL_SIGNAL_INDEX, 1)
        }

        this._sharedReady = false

        if (this._debugLogs) {
            this._postMainMessage({ message: "DENOISER_WORKLET_DESTROYED" })
        }
    }

    private _copyMonoToOutput(input: Float32Array, output: Float32Array[]) {
        for (let i = 0; i < input.length; i += 1) {
            const value = input[i]
            for (let channel = 0; channel < output.length; channel += 1) {
                output[channel][i] = value
            }
        }
    }

    private _postMainMessage(payload: { message: string; error?: string }) {
        this.port.postMessage(payload)
    }

    private _maybeLogProcessOverrun(
        processStartMs: number,
        inputDurationMs: number,
        inputFrames: number,
    ) {
        if (inputDurationMs <= 0) {
            return
        }

        const elapsedMs = this._nowMs() - processStartMs
        if (elapsedMs <= inputDurationMs) {
            return
        }

        console.warn(
            `[DenoiserWorklet][process] overrun elapsedMs=${elapsedMs.toFixed(3)} inputDurationMs=${inputDurationMs.toFixed(3)} inputFrames=${inputFrames}`,
        )
    }

    private _framesToMs(frames: number): number {
        if (!Number.isFinite(frames) || frames <= 0) {
            return 0
        }

        const sr =
            typeof sampleRate === "number" && Number.isFinite(sampleRate) && sampleRate > 0
                ? sampleRate
                : 48_000
        return (frames / sr) * 1000
    }

    private _nowMs(): number {
        if (globalThis.performance && typeof globalThis.performance.now === "function") {
            return globalThis.performance.now()
        }
        return Date.now()
    }
}

registerProcessor("DenoiserWorklet", DenoiserWorklet)
