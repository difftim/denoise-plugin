import { DenoiseModule } from "./DenoiseModule"

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
    df_get_lookahead: (state: number) => number
    df_process_frame: (state: number, input: Float32Array) => Float32Array
    df_set_atten_lim: (state: number, limDb: number) => void
    df_set_post_filter_beta: (state: number, beta: number) => void
}

let bindings: DeepFilterBindings | undefined
let wasmInitialized = false

export function initDeepFilterWasm(wasmBinary: ArrayBuffer): void {
    if (wasmInitialized) return

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    bindings = (require("../../dist/deepfilter-bindgen.js") as { default: DeepFilterBindings })
        .default
    bindings.initSync(wasmBinary)
    wasmInitialized = true
}

export class DeepFilterModule extends DenoiseModule<DeepFilterRuntimeConfig> {
    readonly moduleId = "deepfilternet"

    private readonly _bindings: DeepFilterBindings
    private _state = 0
    private _frameLength = 0
    private _lookahead = 0
    private _disposed = false

    constructor(config: DeepFilterRuntimeConfig, wasmBinary?: ArrayBuffer) {
        super(config)

        if (wasmBinary) {
            initDeepFilterWasm(wasmBinary)
        }

        if (!bindings) {
            throw new Error(
                "DeepFilter WASM not initialized. Provide deepfilterWasm in INIT_PIPELINE.",
            )
        }
        this._bindings = bindings
        this._createState(this._config)
    }

    get frameLength(): number {
        return this._frameLength
    }

    get lookahead(): number {
        return this._lookahead
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
        this._config = { ...config }
        this._bindings.df_set_atten_lim(this._state, config.attenLimDb)
        this._bindings.df_set_post_filter_beta(this._state, config.postFilterBeta)
    }

    dispose(): void {
        if (this._disposed) return

        this._disposed = true
        if (this._state) {
            this._bindings.df_destroy(this._state)
            this._state = 0
        }
    }

    private _createState(config: DeepFilterRuntimeConfig): void {
        if (this._state) {
            this._bindings.df_destroy(this._state)
            this._state = 0
        }

        this._state = this._bindings.df_create_default(config.attenLimDb)

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
        this._lookahead = this._bindings.df_get_lookahead(this._state)
        this._bindings.df_set_atten_lim(this._state, config.attenLimDb)
        this._bindings.df_set_post_filter_beta(this._state, config.postFilterBeta)
    }
}
