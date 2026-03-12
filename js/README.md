# Audio-Pipeline-Plugin

- A WebAssembly module implementing fixed-order audio pipeline processing for web frontends.
- The denoise stage currently supports `rnnoise` and `deepfilternet`.

## Denoise Stage Modules

- `rnnoise` (default)
- `deepfilternet`

## DeepFilter Build Artifacts

- DeepFilter wasm source package: `DeepFilterNet/libDF/pkg/df.js` + `df_bg.wasm`.
- Artifact generator: `node ./scripts/build-deepfilter-artifacts.mjs`.
- Generated files: `src/dist/deepfilter-bindgen.js`, `src/dist/rnnoise-sync.js`, `dist/deepfilter.wasm`.
- `build:js` runs artifact generation first, then bundles worklet + library outputs.

## Example

```ts
import { AudioPipelineTrackProcessor } from "@cc-livekit/audio-pipeline-plugin"

const processor = new AudioPipelineTrackProcessor({
    workletUrl: "/assets/AudioPipelineWorklet.js",
    stages: {
        denoise: "rnnoise",
    },
    moduleConfigs: {
        rnnoise: {
            vadLogs: true,
            vadLogIntervalMs: 1000,
        },
        deepfilternet: {
            attenLimDb: 100,
            postFilterBeta: 0,
        },
    },
})

await processor.setModuleConfig("rnnoise", { vadLogs: true, vadLogIntervalMs: 800 })
await processor.setModuleConfig("deepfilternet", { attenLimDb: 30, postFilterBeta: 0.02 })
await processor.setStageModule("denoise", "deepfilternet")
await processor.setStageModule("denoise", "rnnoise")
```

## Runtime Behavior

- Single `AudioWorklet` runtime.
- **WASM and models are loaded only at init.** Both `rnnoise` and `deepfilternet` WASM binaries are fetched and both modules are created during `init()`. No model or WASM is loaded when switching modules or when calling `setModuleConfig` later.
- `setStageModule("denoise", ...)` switches the active denoise module in-place (rnnoise ↔ deepfilternet). Only the already-loaded active module is used; no extra loading.
- `setModuleConfig("deepfilternet", ...)` after init only updates parameters (`attenLimDb`, `postFilterBeta`). DeepFilter uses the **built-in model only** (no custom model loading).
- `setModuleConfig("rnnoise", ...)` updates rnnoise-only config.
- `vadLogs` and `vadLogIntervalMs` are `rnnoise`-only configs.
  - They are ignored by `deepfilternet`.
  - Updating rnnoise config while deepfilter is active is cached and applied when switching back to rnnoise.
- Input audio must be **48 kHz**; the pipeline does not perform sample-rate conversion.
