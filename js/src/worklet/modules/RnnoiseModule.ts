import createRNNWasmModuleSync from "../../dist/rnnoise-sync.js"
import type { ResolvedRnnoiseModuleConfig } from "../../shared/normalize"
import { DenoiseModule } from "./DenoiseModule"

const RNNOISE_FRAME = 480
const RNNOISE_SCALE = 32768

interface IRnnoiseModule extends EmscriptenModule {
    _malloc: (size: number) => number
    _free: (pointer: number) => void
    _rnnoise_create: () => number
    _rnnoise_destroy: (context: number) => void
    _rnnoise_process_frame: (context: number, output: number, input: number) => number
}

export class RnnoiseModule extends DenoiseModule<ResolvedRnnoiseModuleConfig> {
    readonly moduleId = "rnnoise"
    readonly frameLength = RNNOISE_FRAME

    private readonly _module: IRnnoiseModule
    private readonly _context: number
    private readonly _inputPtr: number
    private readonly _outputPtr: number
    private readonly _inputHeap: Float32Array
    private readonly _outputHeap: Float32Array
    private _disposed = false

    constructor(config: ResolvedRnnoiseModuleConfig, wasmBinary?: ArrayBuffer) {
        super(config)

        this._module = createRNNWasmModuleSync(
            wasmBinary ? { wasmBinary } : {},
        ) as IRnnoiseModule
        this._context = this._module._rnnoise_create()

        if (!this._context) {
            throw new Error("Failed to initialize RNNoise context")
        }

        this._inputPtr = this._module._malloc(RNNOISE_FRAME * Float32Array.BYTES_PER_ELEMENT)
        this._outputPtr = this._module._malloc(RNNOISE_FRAME * Float32Array.BYTES_PER_ELEMENT)

        if (!this._inputPtr || !this._outputPtr) {
            if (this._inputPtr) this._module._free(this._inputPtr)
            if (this._outputPtr) this._module._free(this._outputPtr)
            this._module._rnnoise_destroy(this._context)
            throw new Error("Failed to allocate RNNoise heap buffers")
        }

        const inputOffset = this._inputPtr >> 2
        const outputOffset = this._outputPtr >> 2
        this._inputHeap = this._module.HEAPF32.subarray(inputOffset, inputOffset + RNNOISE_FRAME)
        this._outputHeap = this._module.HEAPF32.subarray(outputOffset, outputOffset + RNNOISE_FRAME)
    }

    processFrame(input: Float32Array, output: Float32Array): number {
        for (let i = 0; i < RNNOISE_FRAME; i += 1) {
            this._inputHeap[i] = input[i] * RNNOISE_SCALE
        }

        const vadScore = this._module._rnnoise_process_frame(
            this._context,
            this._outputPtr,
            this._inputPtr,
        )

        const invScale = 1 / RNNOISE_SCALE
        for (let i = 0; i < RNNOISE_FRAME; i += 1) {
            output[i] = this._outputHeap[i] * invScale
        }

        return vadScore
    }

    updateConfig(config: ResolvedRnnoiseModuleConfig): void {
        this._config = { ...config }
    }

    dispose(): void {
        if (this._disposed) return

        this._disposed = true
        this._module._rnnoise_destroy(this._context)
        this._module._free(this._inputPtr)
        this._module._free(this._outputPtr)
    }
}
