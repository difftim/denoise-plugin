import { Track } from "livekit-client";
import type { AudioProcessorOptions, Room, TrackProcessor } from "livekit-client";
import { DenoiseOptions, type DenoiserEngine } from "./options";
export type DenoiseFilterOptions = DenoiseOptions;
interface DeepFilterRuntimeParams {
    attenLimDb?: number;
    postFilterBeta?: number;
}
export interface DeepFilterRuntimeConfig extends DeepFilterRuntimeParams {
    modelUrl?: string;
    modelBuffer?: ArrayBuffer;
}
export declare class DenoiseTrackProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
    private static readonly loadedContexts;
    private static readonly loadedWorkletUrls;
    readonly name = "denoise-filter";
    processedTrack?: MediaStreamTrack | undefined;
    private audioOpts?;
    private filterOpts?;
    private denoiseNode?;
    private orgSourceNode?;
    private enabled;
    private _nextRequestId;
    private _pendingCommands;
    private _operationQueue;
    private readonly _handleRuntimeMessage;
    constructor(options?: DenoiseFilterOptions);
    static isSupported(): boolean;
    init(opts: AudioProcessorOptions): Promise<void>;
    restart(opts: AudioProcessorOptions): Promise<void>;
    onPublish(room: Room): Promise<void>;
    onUnpublish(): Promise<void>;
    setEnabled(enable: boolean): Promise<void>;
    setEngine(engine: DenoiserEngine): Promise<void>;
    setDeepFilterParams(params: DeepFilterRuntimeParams): Promise<void>;
    setDeepFilterConfig(config: DeepFilterRuntimeConfig): Promise<void>;
    isEnabled(): Promise<boolean>;
    destroy(): Promise<void>;
    _initInternal(opts: AudioProcessorOptions, restart: boolean): Promise<void>;
    private _runSerial;
    private _sendCommand;
    private _resolveCommand;
    private _rejectCommand;
    private _handleRuntimeLog;
    private _rejectAllPendingCommands;
    private _getVadLogIntervalMs;
    private _getResolvedEngine;
    private _resolveDeepFilterOptions;
    private _resolveModelUrl;
    private _resolveDeepFilterAttenLimDb;
    private _resolveDeepFilterPostFilterBeta;
    private _ensureFilterOptions;
    private _fetchDeepFilterModel;
    _closeInternal(): void;
}
export {};
