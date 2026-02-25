# Denoise-Plugin

- A WebAssembly module implementing RNNoise and DeepFilterNet denoise processing for web frontends.
- Designed as a LiveKit `TrackProcessor` for realtime audio denoising.

## Engines

- `rnnoise` (default)
- `deepfilternet`

## DeepFilter Build Artifacts

- DeepFilter wasm source package: `DeepFilterNet/libDF/pkg/df.js` + `df_bg.wasm`.
- Artifact generator: `node ./scripts/build-deepfilter-artifacts.mjs`.
- Generated files: `src/dist/deepfilter-bindgen.js`, `src/dist/deepfilter-wasm-base64.js`, `src/dist/deepfilter-sync.js`.
- `build:js` runs artifact generation first, then bundles worklet + library outputs.
- End users do not need local Rust / wasm-pack; the published package includes bundled runtime artifacts.

## Example

```ts
import { DenoiseTrackProcessor } from "@cc-livekit/denoise-plugin"

const processor = new DenoiseTrackProcessor({
    workletUrl: "/assets/DenoiserWorklet.js",
    engine: "deepfilternet",
    deepFilter: {
        modelUrl: "/assets/DeepFilterNet3_onnx.tar.gz",
        attenLimDb: 100,
        postFilterBeta: 0,
    },
})

await processor.setDeepFilterParams({ attenLimDb: 30, postFilterBeta: 0.02 })
await processor.setDeepFilterConfig({ modelUrl: "/assets/DeepFilterNet3_onnx.tar.gz" })
await processor.setEngine("rnnoise")
await processor.setEngine("deepfilternet")
```

## Runtime Behavior

- Single `AudioWorklet` runtime (`worker` removed).
- `setEngine()` switches backend in-place without restart.
- `setDeepFilterParams()` updates runtime DeepFilter params (`attenLimDb`, `postFilterBeta`) only when engine is `deepfilternet`.
- `setDeepFilterConfig()` supports dynamic model + param update.
  - If both `modelBuffer` and `modelUrl` are passed, `modelBuffer` is used.
  - `modelUrl` is fetched on the main thread, then transferred to worklet.
- When current engine is `rnnoise`, DeepFilter param/model update commands are ignored (no cache, no auto switch).
- Switching failures keep the previous backend active and report an error.
