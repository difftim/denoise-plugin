import Combine
import Foundation
import LiveKit
import RNNoise

public class DenoisePluginFilter {
    public var isEnabled: Bool {
        get { _state.isEnabled }
        set { _state.mutate { $0.isEnabled = newValue } }
    }

    private var rnn: RNNoiseWrapper?

    private struct State {
        var isEnabled: Bool = true
        var sampleRateHz: Int?
        var channels: Int?
        var debugLog: Bool = false
        var vadLogs: Bool = false
    }

    private let _state = StateSync(State())

    public init(debugLog: Bool = false, vadLogs: Bool = false) {
        _state.mutate {
            $0.debugLog = debugLog
            $0.vadLogs = vadLogs
        }
    }
}

extension DenoisePluginFilter: AudioCustomProcessingDelegate {
    public var audioProcessingName: String { "denoise-filter" }

    // This will be invoked anytime sample rate changes, for example switching Speaker <-> AirPods.
    public func audioProcessingInitialize(
        sampleRate sampleRateHz: Int,
        channels: Int
    ) {
        if _state.debugLog {
            print(
                "DenoisePluginFilter: initialize: sampleRateHz=\(sampleRateHz), channels=\(channels)"
            )
        }

        let isNeedInit = _state.mutate {
            let result =
                ($0.sampleRateHz != sampleRateHz || $0.channels != channels)
            $0.sampleRateHz = sampleRateHz
            $0.channels = channels
            return result
        }

        if isNeedInit {
            rnn = nil

            rnn = RNNoiseWrapper()
            rnn?.initialize(Int32(sampleRateHz), numChannels: Int32(channels))

            if _state.debugLog {
                print(
                    "DenoisePluginFilter: initialize: sampleRateHz=\(sampleRateHz), channels=\(channels), rnn=\(rnn)"
                )
            }
        }
    }

    public func audioProcessingProcess(audioBuffer: LiveKit.LKAudioBuffer) {
        guard _state.isEnabled else { return }

        guard audioBuffer.channels == _state.channels else {
            return
        }

        for channel in 0..<audioBuffer.channels {
            let vad = rnn?.process(
                withBands: Int32(audioBuffer.bands),
                frames: Int32(audioBuffer.frames),
                bufferSize: Int32(audioBuffer.framesPerBand),
                buffer: audioBuffer.rawBuffer(forChannel: channel)
            )

            if _state.debugLog && _state.vadLogs {
                print(
                    "DenoisePluginFilter: process: channel=\(channel), withBands=\(audioBuffer.bands), frames=\(audioBuffer.frames), bufferSize=\(audioBuffer.framesPerBand), vad=\(vad)"
                )
            }
        }
    }

    public func audioProcessingRelease() {
        if _state.debugLog {
            print("DenoisePluginFilter: release: rnn=\(rnn)")
        }
        rnn = nil
    }
}
