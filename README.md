# Denoise-Plugin

- A WebAssembly module implementing the RNNoise noise suppression library for web frontends.
- Designed as a denoise filter for the LiveKit audio processor, ensuring effective noise reduction for high-quality audio processing.

## Web
```js
npm install @cc-livekit/denoise-plugin@1.0.4

yarn add @cc-livekit/denoise-plugin@1.0.4

pnpm install @cc-livekit/denoise-plugin@1.0.4
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