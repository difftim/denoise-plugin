import type { InternalWasmUrls } from "./normalize";
import type { WasmBinaries } from "./contracts";
export declare function fetchWasmBinaries(urls: InternalWasmUrls, onDebug?: (message: string, data?: unknown) => void): Promise<{
    wasmBinaries: WasmBinaries;
    wasmTransferables: ArrayBuffer[];
}>;
