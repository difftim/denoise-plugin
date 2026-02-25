import { Track } from "livekit-client";
import type { AudioProcessorOptions, Room, TrackProcessor } from "livekit-client";
import type { AudioPipelineOptions, DeepFilterModuleConfig, DenoiseModuleId, PipelineStage, RnnoiseModuleConfig } from "./options";
export interface PendingCommand {
    command: string;
    timeoutId: ReturnType<typeof setTimeout>;
    resolve: () => void;
    reject: (error: Error) => void;
}
export declare class AudioPipelineTrackProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
    private static readonly loadedContexts;
    private static readonly loadedWorkletUrls;
    readonly name = "audio-pipeline-filter";
    processedTrack?: MediaStreamTrack | undefined;
    private audioOpts?;
    private denoiseNode?;
    private orgSourceNode?;
    private enabled;
    private _options;
    private _nextRequestId;
    private _pendingCommands;
    private _operationQueue;
    private readonly _handleRuntimeMessage;
    constructor(options: AudioPipelineOptions);
    static isSupported(): boolean;
    init(opts: AudioProcessorOptions): Promise<void>;
    restart(opts: AudioProcessorOptions): Promise<void>;
    onPublish(room: Room): Promise<void>;
    onUnpublish(): Promise<void>;
    setEnabled(enable: boolean): Promise<void>;
    setStageModule(stage: PipelineStage, moduleId: DenoiseModuleId): Promise<void>;
    setModuleConfig(moduleId: "rnnoise", config: RnnoiseModuleConfig): Promise<void>;
    setModuleConfig(moduleId: "deepfilternet", config: DeepFilterModuleConfig): Promise<void>;
    isEnabled(): Promise<boolean>;
    destroy(): Promise<void>;
    private _setRnnoiseConfig;
    private _setDeepFilterConfig;
    private _initInternal;
    private _resolveDeepFilterModelBuffer;
    private _runSerial;
    private _sendCommand;
    private _resolveCommand;
    private _rejectCommand;
    private _rejectAllPendingCommands;
    private _fetchDeepFilterModel;
    private _closeInternal;
}
