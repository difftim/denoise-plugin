# Denoise-Plugin

- A WebAssembly module implementing the RNNoise noise suppression library for web frontends.
- Designed as a denoise filter for the LiveKit audio processor, ensuring effective noise reduction for high-quality audio processing.

## Engines

- `rnnoise` (default)
- `deepfilternet` (precompiled sync runtime bundled in worker)

## DeepFilter Build Artifacts

- DeepFilter wasm source package: `DeepFilterNet/libDF/pkg/df.js` + `df_bg.wasm`.
- Artifact generator: `node ./scripts/build-deepfilter-artifacts.mjs`.
- Generated files: `src/dist/deepfilter-bindgen.js`, `src/dist/deepfilter-wasm-base64.js`, `src/dist/deepfilter-sync.js`.
- `build:js` runs artifact generation first, then bundles worker/worklet.
- End users do not need local Rust / wasm-pack; publish package already includes bundled runtime.

### Example

```ts
import { DenoiseTrackProcessor } from "@cc-livekit/denoise-plugin"

const processor = new DenoiseTrackProcessor({
    workletUrl: "/assets/DenoiserWorklet.js",
    workerUrl: "/assets/DenoiserWorker.js",
    engine: "deepfilternet",
    deepFilter: {
        // Optional external model tar.gz. If omitted, built-in model is used.
        modelUrl: "/assets/DeepFilterNet3_onnx.tar.gz",
        attenLimDb: 100,
        postFilterBeta: 0,
    },
})

await processor.setDeepFilterParams({ attenLimDb: 30, postFilterBeta: 0.02 })
await processor.setEngine("rnnoise") // restart-based switch
```

## Runtime Behavior

- `setEngine()` switches backend via `restart`.
- `setDeepFilterParams()` updates only DeepFilter runtime params (`attenLimDb`, `postFilterBeta`).
- If DeepFilter initialization fails, worker reports an error and stops; no automatic fallback to RNNoise.
