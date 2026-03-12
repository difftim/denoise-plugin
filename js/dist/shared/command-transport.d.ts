import type { MainToWorkletMessage, RuntimeMessage } from "./contracts";
export declare class CommandTransport {
    private _nextRequestId;
    private readonly _pendingCommands;
    send(port: MessagePort, message: MainToWorkletMessage, transferables?: Transferable[]): Promise<number>;
    resolve(requestId?: number): void;
    reject(payload: Extract<RuntimeMessage, {
        type: "COMMAND_ERROR";
    }>): void;
    close(reason: string): void;
    getPendingCommand(requestId?: number): string | undefined;
}
