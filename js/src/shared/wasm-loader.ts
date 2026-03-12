import type { InternalWasmUrls } from "./normalize"
import type { WasmBinaries } from "./contracts"

export async function fetchWasmBinaries(
    urls: InternalWasmUrls,
    onDebug?: (message: string, data?: unknown) => void,
): Promise<{
    wasmBinaries: WasmBinaries
    wasmTransferables: ArrayBuffer[]
}> {
    const wasmBinaries: WasmBinaries = {}
    const wasmTransferables: ArrayBuffer[] = []

    onDebug?.("fetching rnnoise wasm", urls.rnnoise)
    const rnnoiseWasm = await fetchBinary(urls.rnnoise, "RNNoise WASM")
    wasmBinaries.rnnoiseWasm = rnnoiseWasm
    wasmTransferables.push(rnnoiseWasm)

    onDebug?.("fetching deepfilter wasm", urls.deepfilter)
    const deepfilterWasm = await fetchBinary(urls.deepfilter, "DeepFilter WASM")
    wasmBinaries.deepfilterWasm = deepfilterWasm
    wasmTransferables.push(deepfilterWasm)

    return { wasmBinaries, wasmTransferables }
}

async function fetchBinary(url: string, label: string): Promise<ArrayBuffer> {
    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`Failed to fetch ${label}: ${response.status} ${response.statusText} (${url})`)
    }
    return response.arrayBuffer()
}
