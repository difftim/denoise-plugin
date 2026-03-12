import type { DenoiseModuleId } from "./options"
import type { LogMessage, WasmBinaries } from "./shared/contracts"
import {
    mergeDeepFilterConfig,
    mergeRnnoiseConfig,
    normalizeDeepFilterConfig,
    normalizeRnnoiseConfig,
    resolveDenoiseModule,
    type ResolvedDeepFilterConfig,
    type ResolvedRnnoiseModuleConfig,
} from "./shared/normalize"
import { collectTransferBuffers } from "./shared/transfer"
import type { WorkerToWorkletMessage, WorkletToWorkerMessage } from "./shared/worker-contracts"
import { Float32ArrayPool } from "./worklet/Float32ArrayPool"
import { DeepFilterModule } from "./worklet/modules/DeepFilterModule"
import { RnnoiseModule } from "./worklet/modules/RnnoiseModule"

type ActiveDenoiseModule = RnnoiseModule | DeepFilterModule

const DEFAULT_FRAME_LENGTH = 480
const LOG_TAG = "[AudioPipeline:Worker]"

class AudioPipelineWorkerRuntime {
    private _port: MessagePort | undefined
    private _debugLogs = false

    private _currentModuleId: DenoiseModuleId = "rnnoise"
    private _processingEnabled = true

    private _rnnoiseConfig: ResolvedRnnoiseModuleConfig = normalizeRnnoiseConfig()
    private _deepFilterConfig: ResolvedDeepFilterConfig = normalizeDeepFilterConfig()

    private _rnnoiseModule: RnnoiseModule | undefined
    private _deepFilterModule: DeepFilterModule | undefined

    private _framePool = new Float32ArrayPool(DEFAULT_FRAME_LENGTH)
    private _pendingRecycles: Float32Array[] = []

    handleGlobalMessage(event: MessageEvent): void {
        const data = event.data as { type?: string; port?: MessagePort; debugLogs?: boolean }

        if (data?.type === "CONNECT_PORT") {
            if (!data.port) {
                throw new Error("CONNECT_PORT message is missing a MessagePort")
            }
            this._port = data.port
            this._port.onmessage = this.handleMessage
            this._logInfo("WORKER_PORT_CONNECTED")
            return
        }

        if (data?.type === "SET_DEBUG") {
            this._debugLogs = Boolean(data.debugLogs)
        }
    }

    readonly handleMessage = (event: MessageEvent<WorkletToWorkerMessage>): void => {
        const msg = event.data
        if (!msg?.type) return

        try {
            switch (msg.type) {
                case "INIT":
                    this._handleInit(msg)
                    break
                case "PROCESS_FRAME_BATCH":
                    this._handleProcessFrameBatch(msg)
                    break
                case "SET_MODULE":
                    this._handleSetModule(msg)
                    break
                case "SET_MODULE_CONFIG":
                    this._handleSetModuleConfig(msg)
                    break
                case "SET_ENABLED":
                    this._processingEnabled = msg.enable
                    this._logInfo(msg.enable ? "PROCESSING_ENABLED" : "PROCESSING_DISABLED")
                    break
                case "DESTROY":
                    this._handleDestroy()
                    break
            }
        } catch (error) {
            this._respondError(error)
        }
    }

    private _handleInit(msg: Extract<WorkletToWorkerMessage, { type: "INIT" }>): void {
        const t0 = performance.now()

        this._debugLogs = msg.debugLogs ?? false
        this._currentModuleId = resolveDenoiseModule(msg.moduleId)
        this._rnnoiseConfig = mergeRnnoiseConfig(normalizeRnnoiseConfig(), msg.moduleConfigs?.rnnoise)
        this._deepFilterConfig = mergeDeepFilterConfig(
            normalizeDeepFilterConfig(),
            msg.moduleConfigs?.deepfilternet,
        )

        this._initAllModules(msg.wasmBinaries)
        const info = this._activateModule(this._currentModuleId)

        this._respond({
            type: "INIT_OK",
            frameLength: info.frameLength,
            lookahead: info.lookahead,
        })

        this._logInfo("WORKER_READY", { elapsed: `${(performance.now() - t0).toFixed(2)}ms` })
    }

    private _handleProcessFrameBatch(
        msg: Extract<WorkletToWorkerMessage, { type: "PROCESS_FRAME_BATCH" }>,
    ): void {
        if (msg.recycleBuffers) {
            for (let i = 0; i < msg.recycleBuffers.length; i++) {
                this._framePool.release(msg.recycleBuffers[i])
            }
        }

        const denoiseModule = this._getActiveModule()
        const outputBuffers: Float32Array[] = []
        const vadScores: (number | undefined)[] = []

        for (let i = 0; i < msg.inputBuffers.length; i++) {
            const input = msg.inputBuffers[i]

            if (!this._processingEnabled || !denoiseModule) {
                const output = this._framePool.acquire()
                output.set(input)
                outputBuffers.push(output)
                vadScores.push(undefined)
            } else if (input.length < denoiseModule.frameLength) {
                this._respondError(`Input buffer too small: ${input.length} < ${denoiseModule.frameLength}`)
                return
            } else {
                try {
                    const output = this._framePool.acquire()
                    vadScores.push(denoiseModule.processFrame(input, output))
                    outputBuffers.push(output)
                } catch (error) {
                    this._respondError(error)
                    return
                }
            }

            this._pendingRecycles.push(input)
        }

        const recycles = this._pendingRecycles.length > 0 ? this._pendingRecycles.splice(0) : undefined
        this._respond(
            {
                type: "FRAME_RESULT_BATCH",
                outputBuffers,
                vadScores,
                recycleBuffers: recycles,
            },
            collectTransferBuffers(outputBuffers, recycles),
        )
    }

    private _handleSetModule(msg: Extract<WorkletToWorkerMessage, { type: "SET_MODULE" }>): void {
        const t0 = performance.now()
        const nextId = resolveDenoiseModule(msg.moduleId)

        if (nextId === this._currentModuleId) {
            this._logInfo("SET_MODULE (already active)", { moduleId: nextId })
            return
        }

        const info = this._activateModule(nextId)
        this._logInfo("SET_MODULE (switch)", {
            to: nextId,
            elapsed: `${(performance.now() - t0).toFixed(2)}ms`,
        })
        this._respond({ type: "MODULE_CHANGED", frameLength: info.frameLength, lookahead: info.lookahead })
    }

    private _handleSetModuleConfig(
        msg: Extract<WorkletToWorkerMessage, { type: "SET_MODULE_CONFIG" }>,
    ): void {
        const t0 = performance.now()

        if (msg.moduleId === "rnnoise") {
            this._rnnoiseConfig = mergeRnnoiseConfig(this._rnnoiseConfig, msg.config)
            this._rnnoiseModule?.updateConfig(this._rnnoiseConfig)
            this._logInfo("SET_MODULE_CONFIG rnnoise", {
                config: msg.config,
                elapsed: `${(performance.now() - t0).toFixed(2)}ms`,
            })
            return
        }

        this._deepFilterConfig = mergeDeepFilterConfig(this._deepFilterConfig, msg.config)
        this._deepFilterModule?.updateConfig(this._deepFilterConfig)
        this._logInfo("SET_MODULE_CONFIG deepfilternet", {
            config: msg.config,
            elapsed: `${(performance.now() - t0).toFixed(2)}ms`,
        })
    }

    private _handleDestroy(): void {
        this._rnnoiseModule?.dispose()
        this._deepFilterModule?.dispose()
        this._rnnoiseModule = undefined
        this._deepFilterModule = undefined
        this._currentModuleId = "rnnoise"
        this._processingEnabled = true
        this._rnnoiseConfig = normalizeRnnoiseConfig()
        this._deepFilterConfig = normalizeDeepFilterConfig()
        this._framePool = new Float32ArrayPool(DEFAULT_FRAME_LENGTH)
        this._pendingRecycles = []
        this._logInfo("WORKER_DESTROYED")
    }

    private _getActiveModule(): ActiveDenoiseModule | undefined {
        return this._currentModuleId === "deepfilternet" ? this._deepFilterModule : this._rnnoiseModule
    }

    private _initAllModules(wasmBinaries: WasmBinaries): void {
        const t0 = performance.now()

        if (!this._rnnoiseModule) {
            this._rnnoiseModule = new RnnoiseModule(this._rnnoiseConfig, wasmBinaries.rnnoiseWasm)
            this._logInfo("PRE_INIT rnnoise", { elapsed: `${(performance.now() - t0).toFixed(2)}ms` })
        }

        const t1 = performance.now()
        if (!this._deepFilterModule) {
            this._deepFilterModule = new DeepFilterModule(
                this._deepFilterConfig,
                wasmBinaries.deepfilterWasm,
            )
            this._logInfo("PRE_INIT deepfilternet", { elapsed: `${(performance.now() - t1).toFixed(2)}ms` })
        }

        this._logInfo("PRE_INIT all modules done", {
            totalElapsed: `${(performance.now() - t0).toFixed(2)}ms`,
        })
    }

    private _activateModule(moduleId: DenoiseModuleId): { frameLength: number; lookahead: number } {
        this._currentModuleId = moduleId
        const active = this._getActiveModule()
        if (!active) {
            throw new Error(`Denoise module is not available: ${moduleId}`)
        }

        const lookahead = active instanceof DeepFilterModule ? active.lookahead : 0
        this._framePool.resize(active.frameLength)

        this._logInfo(`MODULE_ACTIVE:${moduleId}`, { frameLength: active.frameLength, lookahead })
        return { frameLength: active.frameLength, lookahead }
    }

    private _respond(msg: WorkerToWorkletMessage, transfer?: Transferable[]): void {
        this._port?.postMessage(msg, transfer ?? [])
    }

    private _respondError(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error)
        this._logError(message)
        this._respond({ type: "ERROR", error: message })
    }

    private _postLog(level: "info" | "error", text: string, data?: unknown): void {
        const payload: LogMessage = {
            type: "LOG",
            level,
            tag: LOG_TAG,
            text,
            data,
        }
        this._port?.postMessage(payload)
    }

    private _logInfo(message: string, data?: unknown): void {
        if (!this._debugLogs) return
        this._postLog("info", message, data)
    }

    private _logError(message: string, data?: unknown): void {
        this._postLog("error", message, data)
    }
}

const runtime = new AudioPipelineWorkerRuntime()

globalThis.onmessage = (event: MessageEvent) => {
    runtime.handleGlobalMessage(event)
}
