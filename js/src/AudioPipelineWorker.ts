import type { DenoiseModuleId } from "./options"
import type { WasmBinaries } from "./shared/contracts"
import {
    defaultWorkletDeepFilterState,
    mergeRnnoiseConfig,
    mergeWorkletDeepFilterState,
    normalizeRnnoiseConfig,
    resolveDenoiseModule,
    type ResolvedRnnoiseModuleConfig,
    type WorkletDeepFilterState,
} from "./shared/normalize"
import type { WorkerToWorkletMessage, WorkletToWorkerMessage } from "./shared/worker-contracts"
import { Float32ArrayPool } from "./worklet/Float32ArrayPool"
import { DeepFilterModule } from "./worklet/modules/DeepFilterModule"
import { RnnoiseModule } from "./worklet/modules/RnnoiseModule"

type ActiveDenoiseModule = RnnoiseModule | DeepFilterModule

let port: MessagePort | undefined
let debugLogs = false

let currentModuleId: DenoiseModuleId = "rnnoise"
let processingEnabled = true

let rnnoiseConfig: ResolvedRnnoiseModuleConfig = normalizeRnnoiseConfig()
let deepFilterState: WorkletDeepFilterState = defaultWorkletDeepFilterState()

let rnnoiseModule: RnnoiseModule | undefined
let deepFilterModule: DeepFilterModule | undefined

let framePool = new Float32ArrayPool(480)
let pendingRecycles: Float32Array[] = []

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

function getActiveModule(): ActiveDenoiseModule | undefined {
    return currentModuleId === "deepfilternet" ? deepFilterModule : rnnoiseModule
}

function initAllModules(wasmBinaries: WasmBinaries): void {
    const t0 = performance.now()

    if (!rnnoiseModule) {
        rnnoiseModule = new RnnoiseModule(rnnoiseConfig, wasmBinaries.rnnoiseWasm)
        logInfo("PRE_INIT rnnoise", { elapsed: `${(performance.now() - t0).toFixed(2)}ms` })
    }

    const t1 = performance.now()
    if (!deepFilterModule) {
        deepFilterModule = new DeepFilterModule(deepFilterState, wasmBinaries.deepfilterWasm)
        logInfo("PRE_INIT deepfilternet", { elapsed: `${(performance.now() - t1).toFixed(2)}ms` })
    }

    logInfo("PRE_INIT all modules done", {
        totalElapsed: `${(performance.now() - t0).toFixed(2)}ms`,
    })
}

function activateModule(moduleId: DenoiseModuleId): { frameLength: number; lookahead: number } {
    currentModuleId = moduleId
    const active = getActiveModule()!
    const lookahead = active instanceof DeepFilterModule ? active.lookahead : 0

    framePool.resize(active.frameLength)

    logInfo(`MODULE_ACTIVE:${moduleId}`, { frameLength: active.frameLength, lookahead })

    return { frameLength: active.frameLength, lookahead }
}

function handleInit(msg: Extract<WorkletToWorkerMessage, { type: "INIT" }>): void {
    const t0 = performance.now()
    debugLogs = msg.debugLogs ?? false
    currentModuleId = resolveDenoiseModule(msg.moduleId)

    rnnoiseConfig = mergeRnnoiseConfig(normalizeRnnoiseConfig(), msg.moduleConfigs?.rnnoise)
    deepFilterState = mergeWorkletDeepFilterState(
        defaultWorkletDeepFilterState(),
        msg.moduleConfigs?.deepfilternet,
    )

    initAllModules(msg.wasmBinaries)
    const info = activateModule(currentModuleId)

    respond({
        type: "INIT_OK",
        frameLength: info.frameLength,
        lookahead: info.lookahead,
    })

    logInfo("WORKER_READY", { elapsed: `${(performance.now() - t0).toFixed(2)}ms` })
}

function handleProcessFrameBatch(
    msg: Extract<WorkletToWorkerMessage, { type: "PROCESS_FRAME_BATCH" }>,
): void {
    const inputs = msg.inputBuffers

    if (msg.recycleBuffers) {
        for (let i = 0; i < msg.recycleBuffers.length; i++) {
            framePool.release(msg.recycleBuffers[i])
        }
    }

    const denoiseModule = getActiveModule()
    const outputBuffers: Float32Array[] = []
    const vadScores: (number | undefined)[] = []

    for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i]

        if (!processingEnabled || !denoiseModule) {
            const output = framePool.acquire()
            output.set(input)
            outputBuffers.push(output)
            vadScores.push(undefined)
        } else if (input.length < denoiseModule.frameLength) {
            respondError(`Input buffer too small: ${input.length} < ${denoiseModule.frameLength}`)
            return
        } else {
            try {
                const output = framePool.acquire()
                vadScores.push(denoiseModule.processFrame(input, output))
                outputBuffers.push(output)
            } catch (error) {
                respondError(error)
                return
            }
        }

        pendingRecycles.push(input)
    }

    const recycles = pendingRecycles.length > 0
        ? pendingRecycles.splice(0)
        : undefined

    const transfer: ArrayBuffer[] = []
    for (let i = 0; i < outputBuffers.length; i++) {
        transfer.push(outputBuffers[i].buffer as ArrayBuffer)
    }
    if (recycles) {
        for (let i = 0; i < recycles.length; i++) {
            transfer.push(recycles[i].buffer as ArrayBuffer)
        }
    }

    respond(
        {
            type: "FRAME_RESULT_BATCH",
            outputBuffers,
            vadScores,
            recycleBuffers: recycles,
        },
        transfer,
    )
}

function handleSetModule(msg: Extract<WorkletToWorkerMessage, { type: "SET_MODULE" }>): void {
    const t0 = performance.now()
    const nextId = resolveDenoiseModule(msg.moduleId)

    if (nextId === currentModuleId) {
        logInfo("SET_MODULE (already active)", { moduleId: nextId })
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
    deepFilterModule.updateConfig(deepFilterState)
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
            case "PROCESS_FRAME_BATCH":
                handleProcessFrameBatch(msg)
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
