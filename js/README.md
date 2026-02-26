# Audio-Pipeline-Plugin

- A WebAssembly module implementing fixed-order audio pipeline processing for web frontends.
- The denoise stage currently supports `rnnoise` and `deepfilternet`.

## Denoise Stage Modules

- `rnnoise` (default)
- `deepfilternet`

## DeepFilter Build Artifacts

- DeepFilter wasm source package: `DeepFilterNet/libDF/pkg/df.js` + `df_bg.wasm`.
- Artifact generator: `node ./scripts/build-deepfilter-artifacts.mjs`.
- Generated files: `src/dist/deepfilter-bindgen.js`, `src/dist/deepfilter-wasm-base64.js`, `src/dist/deepfilter-sync.js`.
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
            bufferOverflowMs: 1000,
        },
        deepfilternet: {
            modelUrl: "/assets/DeepFilterNet3_onnx.tar.gz",
            attenLimDb: 100,
            postFilterBeta: 0,
        },
    },
})

await processor.setModuleConfig("rnnoise", { vadLogs: true, bufferOverflowMs: 800 })
await processor.setModuleConfig("deepfilternet", { attenLimDb: 30, postFilterBeta: 0.02 })
await processor.setStageModule("denoise", "deepfilternet")
await processor.setStageModule("denoise", "rnnoise")
```

## Runtime Behavior

- Single `AudioWorklet` runtime.
- `setStageModule("denoise", ...)` switches denoise module in-place without restart.
- `setModuleConfig("deepfilternet", ...)` supports dynamic model + param update.
  - If both `modelBuffer` and `modelUrl` are passed, `modelBuffer` is used.
  - `modelUrl` is fetched on the main thread and transferred to worklet.
- `vadLogs` and `bufferOverflowMs` are `rnnoise`-only configs.
  - They are ignored by `deepfilternet`.
  - Updating rnnoise config while deepfilter is active is cached and applied when switching back to rnnoise.
- If sample rate is not `48000`, runtime auto-resamples (`input -> 48000 -> denoise -> original sample rate`).
