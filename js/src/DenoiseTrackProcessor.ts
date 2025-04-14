import { Track } from "livekit-client"
import type { AudioProcessorOptions, Room, TrackProcessor } from "livekit-client"
import { DenoiseOptions } from "./options"
export type DenoiseFilterOptions = DenoiseOptions

const DenoiserWorkletCode = process.env.DENOISER_WORKLET

export class DenoiseTrackProcessor
    implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
    static #hasLoadWorkModule: boolean = false

    readonly name = "denoise-filter"
    processedTrack?: MediaStreamTrack | undefined
    private audioOpts?: AudioProcessorOptions | undefined
    private filterOpts?: DenoiseFilterOptions | undefined
    private denoiseNode?: AudioWorkletNode | undefined
    private orgSourceNode?: MediaStreamAudioSourceNode | undefined
    private enabled: boolean = true

    constructor(options?: DenoiseFilterOptions) {
        this.filterOpts = options ?? { debugLogs: false, bufferOverflowMs: 0 }
    }

    static isSupported(): boolean {
        return true
    }

    async init(opts: AudioProcessorOptions): Promise<void> {
        if (this.filterOpts?.debugLogs) {
            console.log("DenoiseTrackProcessor.init", opts)
        }
        await this._initInternal(opts, false)
    }

    async restart(opts: AudioProcessorOptions): Promise<void> {
        // restart with empty audio context
        opts.audioContext = opts.audioContext ?? this.audioOpts?.audioContext

        if (this.filterOpts?.debugLogs) {
            console.log("DenoiseTrackProcessor.restart", opts)
        }
        await this._initInternal(opts, true)
    }

    async onPublish(room: Room): Promise<void> {
        if (this.filterOpts?.debugLogs) {
            console.log("DenoiseTrackProcessor.onPublish", room)
        }
    }

    async onUnpublish(): Promise<void> {
        if (this.filterOpts?.debugLogs) {
            console.log("DenoiseTrackProcessor.onUnpublish")
        }
    }

    async setEnabled(enable: boolean): Promise<void> {
        if (this.filterOpts?.debugLogs) {
            console.log("DenoiseTrackProcessor.setEnabled", enable)
        }

        if (this.denoiseNode) {
            this.enabled = enable
            this.denoiseNode.port.postMessage({ message: "SET_ENABLED", enable })
        }
    }

    async isEnabled(): Promise<boolean> {
        if (this.denoiseNode) {
            return this.enabled
        } else {
            return false
        }
    }

    async destroy(): Promise<void> {
        if (this.filterOpts?.debugLogs) {
            console.log("DenoiseTrackProcessor.destroy")
        }
    }

    async _initInternal(opts: AudioProcessorOptions, restart: boolean): Promise<void> {
        if (!opts || !opts.audioContext || !opts.track || !DenoiserWorkletCode) {
            throw new Error("audioContext and track are required")
        }

        if (restart) {
            this._closeInternal()
        }

        this.audioOpts = opts

        if (DenoiseTrackProcessor.#hasLoadWorkModule === false) {
            console.log("DenoiserWorkletCode:", DenoiserWorkletCode.length)
            const blob = new Blob([DenoiserWorkletCode], {
                type: "application/javascript",
            })
            await this.audioOpts.audioContext.audioWorklet.addModule(URL.createObjectURL(blob))

            DenoiseTrackProcessor.#hasLoadWorkModule = true
        }

        // process node
        this.denoiseNode = new AudioWorkletNode(this.audioOpts.audioContext, "DenoiserWorklet", {
            processorOptions: {
                debugLogs: this.filterOpts?.debugLogs,
                vadLogs: this.filterOpts?.vadLogs,
            },
        })

        // source node
        this.orgSourceNode = this.audioOpts.audioContext.createMediaStreamSource(
            new MediaStream([this.audioOpts.track]),
        )
        // source node==>process node
        this.orgSourceNode.connect(this.denoiseNode)

        // destination node
        const destination = this.audioOpts.audioContext.createMediaStreamDestination()
        // process node==>destination node
        this.denoiseNode.connect(destination)

        this.processedTrack = destination.stream.getAudioTracks()[0]

        if (this.filterOpts?.debugLogs) {
            console.log(`DenoiseTrackProcessor.init: sourceID: ${this.audioOpts.track.id}, newTrackID: ${this.processedTrack.id}`)
        }
    }

    _closeInternal() {
        this.denoiseNode?.port.postMessage({ message: "DESTORY" })
        this.denoiseNode?.disconnect()
        this.orgSourceNode?.disconnect()
        this.denoiseNode = undefined
        this.orgSourceNode = undefined
        this.processedTrack = undefined
    }
}
