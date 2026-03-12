import { COMMAND_TIMEOUT_MS } from "./contracts"
import type { MainToWorkletMessage, RuntimeMessage } from "./contracts"

interface PendingCommand {
    command: string
    timeoutId: ReturnType<typeof setTimeout>
    resolve: () => void
    reject: (error: Error) => void
}

export class CommandTransport {
    private _nextRequestId = 1
    private readonly _pendingCommands = new Map<number, PendingCommand>()

    async send(
        port: MessagePort,
        message: MainToWorkletMessage,
        transferables?: Transferable[],
    ): Promise<number> {
        const requestId = this._nextRequestId++

        await new Promise<void>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this._pendingCommands.delete(requestId)
                reject(new Error(`Command timeout after ${COMMAND_TIMEOUT_MS}ms: ${message.type}`))
            }, COMMAND_TIMEOUT_MS)

            this._pendingCommands.set(requestId, {
                command: message.type,
                timeoutId,
                resolve,
                reject,
            })

            try {
                port.postMessage({ ...message, requestId }, transferables ?? [])
            } catch (error) {
                clearTimeout(timeoutId)
                this._pendingCommands.delete(requestId)
                reject(error instanceof Error ? error : new Error(String(error)))
            }
        })

        return requestId
    }

    resolve(requestId?: number): void {
        if (requestId === undefined) return

        const pending = this._pendingCommands.get(requestId)
        if (!pending) return

        clearTimeout(pending.timeoutId)
        this._pendingCommands.delete(requestId)
        pending.resolve()
    }

    reject(payload: Extract<RuntimeMessage, { type: "COMMAND_ERROR" }>): void {
        const errorMessage = payload.error ?? `Runtime command failed: ${payload.command ?? "unknown"}`

        if (payload.requestId === undefined) {
            return
        }

        const pending = this._pendingCommands.get(payload.requestId)
        if (!pending) {
            return
        }

        clearTimeout(pending.timeoutId)
        this._pendingCommands.delete(payload.requestId)
        pending.reject(new Error(errorMessage))
    }

    close(reason: string): void {
        for (const pending of this._pendingCommands.values()) {
            clearTimeout(pending.timeoutId)
            pending.reject(new Error(reason))
        }
        this._pendingCommands.clear()
    }

    getPendingCommand(requestId?: number): string | undefined {
        if (requestId === undefined) return undefined
        return this._pendingCommands.get(requestId)?.command
    }
}
