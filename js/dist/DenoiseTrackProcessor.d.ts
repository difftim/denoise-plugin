import { Track } from "livekit-client";
import type { AudioProcessorOptions, Room, TrackProcessor } from "livekit-client";
import { DenoiseOptions } from "./options";
export type DenoiseFilterOptions = DenoiseOptions;
export declare class DenoiseTrackProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
    readonly name = "denoise-filter";
    processedTrack?: MediaStreamTrack | undefined;
    private audioOpts?;
    private filterOpts?;
    private denoiseNode?;
    private orgSourceNode?;
    private enabled;
    constructor(options?: DenoiseFilterOptions);
    static isSupported(): boolean;
    init(opts: AudioProcessorOptions): Promise<void>;
    restart(opts: AudioProcessorOptions): Promise<void>;
    onPublish(room: Room): Promise<void>;
    setEnabled(enable: boolean): Promise<void>;
    isEnabled(): Promise<boolean>;
    destroy(): Promise<void>;
    _initInternal(opts: AudioProcessorOptions): Promise<void>;
    _closeInternal(): void;
}
