import type { DenoiseModuleId } from "./options"
import type { WasmBinaries, WorkletModuleConfigPayloadMap } from "./shared/contracts"
import {
    cloneBytes,
    defaultWorkletDeepFilterState,
    mergeRnnoiseConfig,
    mergeWorkletDeepFilterState,
    normalizeRnnoiseConfig,
    resolveDenoiseModule,
    sameBytes,
    type ResolvedRnnoiseModuleConfig,
    type WorkletDeepFilterState,
} from "./shared/normalize"
import type { WorkerToWorkletMessage, WorkletToWorkerMessage } from "./shared/worker-contracts"
import { BufferPool } from "./shared/BufferPool"
import { DeepFilterModule, initDeepFilterWasm } from "./worklet/modules/DeepFilterModule"
import { RnnoiseModule } from "./worklet/modules/RnnoiseModule"

type ActiveDenoiseModule = RnnoiseModule | DeepFilterModule

let port: MessagePort | undefined
let debugLogs = false

let currentModuleId: DenoiseModuleId = "rnnoise"
let processingEnabled = true

let rnnoiseWasm: ArrayBuffer | undefined
let deepfilterWasm: ArrayBuffer | undefined

let rnnoiseConfig: ResolvedRnnoiseModuleConfig = normalizeRnnoiseConfig()
let deepFilterState: WorkletDeepFilterState = defaultWorkletDeepFilterState()
let lastDfModelBytes: Uint8Array | undefined

let rnnoiseModule: RnnoiseModule | undefined
let deepFilterModule: DeepFilterModule | undefined

let outputPool = new BufferPool(480)
let poolLogCounter = 0

const LOG_TAG = "[AudioPipeline:Worker]"

function logInfo(message: string, data?: unknown): void {
    if (!debugLogs) return
    port?.postMessage({
        type: "LOG",
        level: "info",
        tag: LOG_TAG,
        text: message,
        data,
    } satisfies WorkerToWorkletMessage)
}

function logError(message: string, data?: unknown): void {
    port?.postMessage({
        type: "LOG",
        level: "error",
        tag: LOG_TAG,
        text: message,
        data,
    } satisfies WorkerToWorkletMessage)
}

function respond(msg: WorkerToWorkletMessage, transfer?: Transferable[]): void {
    port?.postMessage(msg, transfer ?? [])
}

function respondError(error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error)
    logError(msg)
    respond({ type: "ERROR", error: msg })
}

function storeWasmBinaries(binaries?: WasmBinaries): void {
    if (!binaries) return
    if (binaries.rnnoiseWasm) rnnoiseWasm = binaries.rnnoiseWasm.slice(0)
    if (binaries.deepfilterWasm) {
        deepfilterWasm = binaries.deepfilterWasm.slice(0)
        initDeepFilterWasm(binaries.deepfilterWasm)
    }
}

function cloneBuffer(buf?: ArrayBuffer): ArrayBuffer | undefined {
    return buf && buf.byteLength > 0 ? buf.slice(0) : undefined
}

function getActiveModule(): ActiveDenoiseModule | undefined {
    return currentModuleId === "deepfilternet" ? deepFilterModule : rnnoiseModule
}

function initAllModules(): void {
    const t0 = performance.now()

    if (!rnnoiseModule) {
        rnnoiseModule = new RnnoiseModule(rnnoiseConfig, cloneBuffer(rnnoiseWasm))
        logInfo("PRE_INIT rnnoise", { elapsed: `${(performance.now() - t0).toFixed(2)}ms` })
    }

    const t1 = performance.now()
    if (!deepFilterModule) {
        deepFilterModule = new DeepFilterModule(deepFilterState, cloneBuffer(deepfilterWasm))
        lastDfModelBytes = cloneBytes(deepFilterState.modelBytes)
        logInfo("PRE_INIT deepfilternet", { elapsed: `${(performance.now() - t1).toFixed(2)}ms` })
    }

    logInfo("PRE_INIT all modules done", {
        totalElapsed: `${(performance.now() - t0).toFixed(2)}ms`,
    })
}

function activateModule(moduleId: DenoiseModuleId): { frameLength: number; lookahead: number } {
    currentModuleId = moduleId
    const active = getActiveModule()!

    outputPool = outputPool.resize(active.frameLength)

    logInfo(`MODULE_ACTIVE:${moduleId}`, { frameLength: active.frameLength })

    return {
        frameLength: active.frameLength,
        lookahead: active instanceof DeepFilterModule ? active.lookahead : 0,
    }
}

function handleInit(msg: Extract<WorkletToWorkerMessage, { type: "INIT" }>): void {
    const t0 = performance.now()
    debugLogs = msg.debugLogs ?? false
    currentModuleId = resolveDenoiseModule(msg.moduleId)

    storeWasmBinaries(msg.wasmBinaries)

    rnnoiseConfig = mergeRnnoiseConfig(normalizeRnnoiseConfig(), msg.moduleConfigs?.rnnoise)
    deepFilterState = mergeWorkletDeepFilterState(
        defaultWorkletDeepFilterState(),
        msg.moduleConfigs?.deepfilternet,
    )

    initAllModules()
    const info = activateModule(currentModuleId)

    respond({
        type: "INIT_OK",
        frameLength: info.frameLength,
        lookahead: info.lookahead,
    })

    logInfo("WORKER_READY", { elapsed: `${(performance.now() - t0).toFixed(2)}ms` })
}

function recycleReturnedOutputBuffers(buffers: Float32Array[] | undefined): void {
    if (!buffers) return

    for (const buf of buffers) {
        outputPool.release(buf)
    }
}

function maybeLogPoolStats(): void {
    if (!debugLogs) return
    poolLogCounter++
    if (poolLogCounter % 500 !== 0) return
    logInfo("WORKER_OUTPUT_POOL_STATS", outputPool.stats())
}

function handleProcessFrame(msg: Extract<WorkletToWorkerMessage, { type: "PROCESS_FRAME" }>): void {
    recycleReturnedOutputBuffers(msg.returnedOutputBuffers)

    const input = msg.inputBuffer
    const denoiseModule = getActiveModule()

    if (!processingEnabled || !denoiseModule) {
        const output = outputPool.acquire()
        output.set(input.length <= output.length ? input : input.subarray(0, output.length))
        respond({ type: "FRAME_RESULT", outputBuffer: output, returnedInputBuffer: input }, [
            output.buffer,
            input.buffer,
        ])
        // maybeLogPoolStats()
        return
    }

    if (input.length < denoiseModule.frameLength) {
        respondError(`Input buffer too small: ${input.length} < ${denoiseModule.frameLength}`)
        return
    }

    try {
        const output = outputPool.acquire()
        const vadScore = denoiseModule.processFrame(input, output)
        respond(
            {
                type: "FRAME_RESULT",
                outputBuffer: output,
                vadScore,
                returnedInputBuffer: input,
            },
            [output.buffer, input.buffer],
        )
    } catch (error) {
        respondError(error)
    }

    // maybeLogPoolStats()
}

function handleSetModule(msg: Extract<WorkletToWorkerMessage, { type: "SET_MODULE" }>): void {
    const t0 = performance.now()
    const nextId = resolveDenoiseModule(msg.moduleId)

    if (msg.config?.rnnoise) {
        rnnoiseConfig = mergeRnnoiseConfig(rnnoiseConfig, msg.config.rnnoise)
        rnnoiseModule?.updateConfig(rnnoiseConfig)
    }
    if (msg.config?.deepfilternet) {
        deepFilterState = mergeWorkletDeepFilterState(deepFilterState, msg.config.deepfilternet)
        if (deepFilterModule) {
            applyDeepFilterUpdate()
        }
    }

    if (nextId === currentModuleId) {
        logInfo("SET_MODULE (same module, config only)", {
            moduleId: nextId,
            elapsed: `${(performance.now() - t0).toFixed(2)}ms`,
        })
        return
    }

    const info = activateModule(nextId)
    logInfo("SET_MODULE (switch)", {
        to: nextId,
        elapsed: `${(performance.now() - t0).toFixed(2)}ms`,
    })
    respond({ type: "MODULE_CHANGED", frameLength: info.frameLength, lookahead: info.lookahead })
}

function handleSetConfig(msg: Extract<WorkletToWorkerMessage, { type: "SET_CONFIG" }>): void {
    const t0 = performance.now()

    if (msg.moduleId === "rnnoise") {
        rnnoiseConfig = mergeRnnoiseConfig(
            rnnoiseConfig,
            msg.config as Partial<ResolvedRnnoiseModuleConfig>,
        )
        rnnoiseModule?.updateConfig(rnnoiseConfig)
        logInfo("SET_CONFIG rnnoise", { elapsed: `${(performance.now() - t0).toFixed(2)}ms` })
        return
    }

    deepFilterState = mergeWorkletDeepFilterState(deepFilterState, msg.config)
    if (deepFilterModule) {
        applyDeepFilterUpdate()
    }
    logInfo("SET_CONFIG deepfilternet", { elapsed: `${(performance.now() - t0).toFixed(2)}ms` })
}

function applyDeepFilterUpdate(): void {
    if (!deepFilterModule) return

    const modelChanged = !sameBytes(lastDfModelBytes, deepFilterState.modelBytes)
    deepFilterModule.updateConfig(deepFilterState)

    if (modelChanged) {
        lastDfModelBytes = cloneBytes(deepFilterState.modelBytes)

        const newFrameLength = deepFilterModule.frameLength
        if (currentModuleId === "deepfilternet") {
            outputPool = outputPool.resize(newFrameLength)
            respond({
                type: "MODULE_CHANGED",
                frameLength: newFrameLength,
                lookahead: deepFilterModule.lookahead,
            })
        }
    }
}

function handleDestroy(): void {
    rnnoiseModule?.dispose()
    deepFilterModule?.dispose()
    rnnoiseModule = undefined
    deepFilterModule = undefined
    logInfo("WORKER_DESTROYED")
}

function handleMessage(event: MessageEvent<WorkletToWorkerMessage>): void {
    const msg = event.data
    if (!msg?.type) return

    try {
        switch (msg.type) {
            case "INIT":
                handleInit(msg)
                break
            case "PROCESS_FRAME":
                handleProcessFrame(msg)
                break
            case "SET_MODULE":
                handleSetModule(msg)
                break
            case "SET_CONFIG":
                handleSetConfig(msg)
                break
            case "SET_ENABLED":
                processingEnabled = msg.enable
                logInfo(msg.enable ? "PROCESSING_ENABLED" : "PROCESSING_DISABLED")
                break
            case "DESTROY":
                handleDestroy()
                break
        }
    } catch (error) {
        respondError(error)
    }
}

globalThis.onmessage = (event: MessageEvent) => {
    const data = event.data
    if (data?.type === "CONNECT_PORT") {
        port = data.port as MessagePort
        port.onmessage = handleMessage
        logInfo("WORKER_PORT_CONNECTED")
        return
    }
    if (data?.type === "SET_DEBUG") {
        debugLogs = Boolean(data.debugLogs)
        return
    }
}
