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
let denoiseModule: ActiveDenoiseModule | undefined
let processingEnabled = true

let rnnoiseWasm: ArrayBuffer | undefined
let deepfilterWasm: ArrayBuffer | undefined

let rnnoiseConfig: ResolvedRnnoiseModuleConfig = normalizeRnnoiseConfig()
let deepFilterState: WorkletDeepFilterState = defaultWorkletDeepFilterState()
let lastDfModelBytes: Uint8Array | undefined

let outputPool = new BufferPool(480, 8)

const LOG_TAG = "[AudioPipeline:Worker]"

function logInfo(message: string, data?: unknown): void {
    if (!debugLogs) return
    if (data !== undefined) {
        console.log(`${LOG_TAG} ${message}`, data)
    } else {
        console.log(`${LOG_TAG} ${message}`)
    }
}

function logError(message: string, data?: unknown): void {
    if (data !== undefined) {
        console.error(`${LOG_TAG} ${message}`, data)
    } else {
        console.error(`${LOG_TAG} ${message}`)
    }
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

function createDenoiseModule(moduleId: DenoiseModuleId): ActiveDenoiseModule {
    if (moduleId === "deepfilternet") {
        return new DeepFilterModule(deepFilterState, cloneBuffer(deepfilterWasm))
    }
    return new RnnoiseModule(rnnoiseConfig, cloneBuffer(rnnoiseWasm))
}

function warmUpModule(module: ActiveDenoiseModule): void {
    if (!(module instanceof DeepFilterModule) || module.lookahead <= 0) return

    const frameLength = module.frameLength
    const silentInput = new Float32Array(frameLength)
    const discardOutput = new Float32Array(frameLength)

    for (let i = 0; i < module.lookahead; i++) {
        module.processFrame(silentInput, discardOutput)
    }

    logInfo("WORKER_WARMUP", { frameLength, lookahead: module.lookahead })
}

function swapModule(moduleId: DenoiseModuleId): { frameLength: number; lookahead: number } {
    const previous = denoiseModule

    const nextModule = createDenoiseModule(moduleId)
    denoiseModule = nextModule
    currentModuleId = moduleId

    if (nextModule instanceof DeepFilterModule) {
        lastDfModelBytes = cloneBytes(deepFilterState.modelBytes)
    }

    // warmUpModule(nextModule)
    previous?.dispose()

    outputPool = outputPool.resize(nextModule.frameLength)

    logInfo(`WORKER_MODULE_ACTIVE:${moduleId}`, { frameLength: nextModule.frameLength })

    return {
        frameLength: nextModule.frameLength,
        lookahead: nextModule instanceof DeepFilterModule ? nextModule.lookahead : 0,
    }
}

function handleInit(msg: Extract<WorkletToWorkerMessage, { type: "INIT" }>): void {
    debugLogs = msg.debugLogs ?? false
    currentModuleId = resolveDenoiseModule(msg.moduleId)

    storeWasmBinaries(msg.wasmBinaries)

    rnnoiseConfig = mergeRnnoiseConfig(normalizeRnnoiseConfig(), msg.moduleConfigs?.rnnoise)
    deepFilterState = mergeWorkletDeepFilterState(
        defaultWorkletDeepFilterState(),
        msg.moduleConfigs?.deepfilternet,
    )

    const info = swapModule(currentModuleId)

    respond({
        type: "INIT_OK",
        frameLength: info.frameLength,
        lookahead: info.lookahead,
    })

    logInfo("WORKER_READY")
}

function handleProcessFrame(msg: Extract<WorkletToWorkerMessage, { type: "PROCESS_FRAME" }>): void {
    const input = msg.inputBuffer

    if (!processingEnabled || !denoiseModule) {
        const output = outputPool.acquire()
        output.set(input.length <= output.length ? input : input.subarray(0, output.length))
        respond({ type: "FRAME_RESULT", outputBuffer: output }, [output.buffer])
        return
    }

    const frameLen = denoiseModule.frameLength
    const numFrames = Math.floor(input.length / frameLen)

    if (numFrames <= 0) {
        respondError(`Input buffer too small: ${input.length} < ${frameLen}`)
        return
    }

    try {
        const singleIn = new Float32Array(frameLen)

        for (let i = 0; i < numFrames; i++) {
            const offset = i * frameLen
            singleIn.set(input.subarray(offset, offset + frameLen))

            const output = outputPool.acquire()
            const vadScore = denoiseModule.processFrame(singleIn, output)

            respond(
                { type: "FRAME_RESULT", outputBuffer: output, vadScore },
                [output.buffer],
            )
        }
    } catch (error) {
        respondError(error)
    }
}

function handleSetModule(msg: Extract<WorkletToWorkerMessage, { type: "SET_MODULE" }>): void {
    const nextId = resolveDenoiseModule(msg.moduleId)

    if (msg.config?.rnnoise) {
        rnnoiseConfig = mergeRnnoiseConfig(rnnoiseConfig, msg.config.rnnoise)
    }
    if (msg.config?.deepfilternet) {
        deepFilterState = mergeWorkletDeepFilterState(deepFilterState, msg.config.deepfilternet)
    }

    if (
        nextId === currentModuleId &&
        nextId === "rnnoise" &&
        denoiseModule instanceof RnnoiseModule
    ) {
        denoiseModule.updateConfig(rnnoiseConfig)
        return
    }

    if (
        nextId === currentModuleId &&
        nextId === "deepfilternet" &&
        denoiseModule instanceof DeepFilterModule
    ) {
        applyDeepFilterUpdate()
        return
    }

    const info = swapModule(nextId)
    respond({ type: "MODULE_CHANGED", frameLength: info.frameLength, lookahead: info.lookahead })
}

function handleSetConfig(msg: Extract<WorkletToWorkerMessage, { type: "SET_CONFIG" }>): void {
    if (msg.moduleId === "rnnoise") {
        rnnoiseConfig = mergeRnnoiseConfig(
            rnnoiseConfig,
            msg.config as Partial<ResolvedRnnoiseModuleConfig>,
        )
        if (denoiseModule instanceof RnnoiseModule && currentModuleId === "rnnoise") {
            denoiseModule.updateConfig(rnnoiseConfig)
        }
        return
    }

    deepFilterState = mergeWorkletDeepFilterState(deepFilterState, msg.config)
    if (denoiseModule instanceof DeepFilterModule && currentModuleId === "deepfilternet") {
        applyDeepFilterUpdate()
    }
}

function applyDeepFilterUpdate(): void {
    const dfModule = denoiseModule as DeepFilterModule
    const modelChanged = !sameBytes(lastDfModelBytes, deepFilterState.modelBytes)
    dfModule.updateConfig(deepFilterState)

    if (modelChanged) {
        lastDfModelBytes = cloneBytes(deepFilterState.modelBytes)
        // warmUpModule(dfModule)

        const newFrameLength = dfModule.frameLength
        outputPool = outputPool.resize(newFrameLength)
        respond({
            type: "MODULE_CHANGED",
            frameLength: newFrameLength,
            lookahead: dfModule.lookahead,
        })
    }
}

function handleDestroy(): void {
    denoiseModule?.dispose()
    denoiseModule = undefined
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
