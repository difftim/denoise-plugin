# Audio-Pipeline-Plugin

- A cross-platform noise processing plugin package.
- Web runtime now uses a fixed-order `AudioPipelineTrackProcessor` with a denoise stage (`rnnoise` / `deepfilternet`).

## Web
```js
npm install @cc-livekit/audio-pipeline-plugin@1.0.4

yarn add @cc-livekit/audio-pipeline-plugin@1.0.4

pnpm install @cc-livekit/audio-pipeline-plugin@1.0.4
```

Web quick use:

```ts
import { AudioPipelineTrackProcessor } from "@cc-livekit/audio-pipeline-plugin"

const processor = new AudioPipelineTrackProcessor({
    workletUrl: "/assets/AudioPipelineWorklet.js",
})
```

## Android
```kotlin
maven {
    url = uri("https://raw.githubusercontent.com/difftim/AndroidRepo/main/")
}

implementation("org.difft.android.libraries:denoise-filter:1.0.1")
```

## Swift
```swift
dependencies: [
    .package(url: "https://github.com/difftim/denoise-plugin.git", from: "1.0.0-swift")
]
```
