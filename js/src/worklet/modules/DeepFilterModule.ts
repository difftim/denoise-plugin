import { DenoiseModule } from "./DenoiseModule"
import createDeepFilterWasmModuleSync from "../../dist/deepfilter-sync.js"

export interface DeepFilterRuntimeConfig {
    modelBytes?: Uint8Array
    attenLimDb: number
    postFilterBeta: number
}

interface DeepFilterBindings {
    initSync: (module: BufferSource | WebAssembly.Module) => unknown
    df_create: (modelBytes: Uint8Array, attenLimDb: number) => number
    df_create_default: (attenLimDb: number) => number
    df_destroy: (state: number) => void
    df_get_frame_length: (state: number) => number
    df_process_frame: (state: number, input: Float32Array) => Float32Array
    df_set_atten_lim: (state: number, limDb: number) => void
    df_set_post_filter_beta: (state: number, beta: number) => void
}

function sameModelBytes(left?: Uint8Array, right?: Uint8Array): boolean {
    if (!left && !right) {
        return true
    }

    if (!left || !right) {
        return false
    }

    if (left.byteLength !== right.byteLength) {
        return false
    }

    for (let index = 0; index < left.byteLength; index += 1) {
        if (left[index] !== right[index]) {
            return false
        }
    }

    return true
}

function cloneModelBytes(bytes?: Uint8Array): Uint8Array | undefined {
    if (!bytes) {
        return undefined
    }

    return bytes.slice(0)
}

export class DeepFilterModule extends DenoiseModule<DeepFilterRuntimeConfig> {
    readonly moduleId = "deepfilternet"

    private readonly _bindings: DeepFilterBindings
    private _state = 0
    private _frameLength = 0
    private _disposed = false

    constructor(config: DeepFilterRuntimeConfig) {
        super({
            ...config,
            modelBytes: cloneModelBytes(config.modelBytes),
        })

        this._bindings = createDeepFilterWasmModuleSync() as DeepFilterBindings
        this._createState(this._config)
    }

    get frameLength(): number {
        return this._frameLength
    }

    processFrame(input: Float32Array, output: Float32Array): number | undefined {
        const processed = this._bindings.df_process_frame(this._state, input)
        if (processed.length !== this._frameLength) {
            throw new Error(
                `DeepFilterNet returned invalid frame size. expected=${this._frameLength}, actual=${processed.length}`,
            )
        }

        output.set(processed)
        return undefined
    }

    updateConfig(config: DeepFilterRuntimeConfig): void {
        const next = {
            ...config,
            modelBytes: cloneModelBytes(config.modelBytes),
        }

        const modelChanged = !sameModelBytes(this._config.modelBytes, next.modelBytes)
        this._config = next

        if (modelChanged) {
            this._createState(next)
            return
        }

        this._bindings.df_set_atten_lim(this._state, next.attenLimDb)
        this._bindings.df_set_post_filter_beta(this._state, next.postFilterBeta)
    }

    dispose(): void {
        if (this._disposed) {
            return
        }

        this._disposed = true

        if (this._state) {
            this._bindings.df_destroy(this._state)
            this._state = 0
        }
    }

    private _createState(config: DeepFilterRuntimeConfig) {
        if (this._state) {
            this._bindings.df_destroy(this._state)
            this._state = 0
        }

        const modelBytes = cloneModelBytes(config.modelBytes)

        if (modelBytes) {
            this._state = this._bindings.df_create(modelBytes, config.attenLimDb)
        } else {
            this._state = this._bindings.df_create_default(config.attenLimDb)
        }

        if (!this._state) {
            throw new Error("Failed to create DeepFilterNet state")
        }

        const frameLength = this._bindings.df_get_frame_length(this._state)
        if (!Number.isFinite(frameLength) || frameLength <= 0) {
            this._bindings.df_destroy(this._state)
            this._state = 0
            throw new Error(`Invalid DeepFilterNet frame length: ${frameLength}`)
        }

        this._frameLength = frameLength
        this._bindings.df_set_atten_lim(this._state, config.attenLimDb)
        this._bindings.df_set_post_filter_beta(this._state, config.postFilterBeta)
    }
}
