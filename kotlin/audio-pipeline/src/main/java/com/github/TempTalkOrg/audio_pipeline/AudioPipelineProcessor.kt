package com.github.TempTalkOrg.audio_pipeline

import android.util.Log
import java.nio.ByteBuffer

enum class AudioModule(val id: String) {
    RNNOISE("rnnoise"),
    DEEP_FILTER_NET("deepfilternet")
}

data class DeepFilterConfig(
        val attenLimDb: Float = 100f,
        val postFilterBeta: Float = 0f,
        val minDbThresh: Float = -15f,
        val maxDbErbThresh: Float = 35f,
        val maxDbDfThresh: Float = 35f
)

class AudioPipelineProcessor(
        private val debugLog: Boolean = false,
        private val vadLogs: Boolean = false,
        private val initialModule: AudioModule = AudioModule.RNNOISE,
        private val deepFilterConfig: DeepFilterConfig = DeepFilterConfig()
) : io.livekit.android.audio.AudioProcessorInterface {

    companion object {
        private const val TAG = "AudioPipeline"

        init {
            try {
                System.loadLibrary("audio_pipeline")
            } catch (e: UnsatisfiedLinkError) {
                Log.e(TAG, "Error loading library: ${e.message}")
            }
        }

        private const val SUPPORT_SAMPLE_RATE_HZ = 48000
        private const val SUPPORT_NUM_CHANNELS = 1
        private const val RNNOISE_FRAME_SIZE = 480
    }

    @Volatile private var rnnoiseContext: Long = 0

    @Volatile private var dfContext: Long = 0

    @Volatile private var activeModule: AudioModule = initialModule

    private var dfFrameLength: Int = 0
    private var dfOutputBuffer: ByteArray? = null
    private var enable: Boolean = true
    private var currentDfConfig: DeepFilterConfig = deepFilterConfig

    override fun getName(): String = "audio-pipeline"

    @Synchronized
    override fun initializeAudioProcessing(sampleRateHz: Int, numChannels: Int) {
        if (debugLog) {
            Log.d(
                    TAG,
                    "initializeAudioProcessing: sampleRateHz=$sampleRateHz, numChannels=$numChannels"
            )
        }

        if (SUPPORT_SAMPLE_RATE_HZ != sampleRateHz || SUPPORT_NUM_CHANNELS != numChannels) {
            return
        }

        initRnnoise()
        initDeepFilter()

        activeModule = initialModule
    }

    @Synchronized override fun isEnabled(): Boolean = enable

    @Synchronized
    fun setEnabled(enable: Boolean) {
        this.enable = enable
    }

    @Synchronized
    fun setModule(module: AudioModule) {
        if (debugLog) {
            Log.d(TAG, "setModule: ${activeModule.id} -> ${module.id}")
        }
        activeModule = module
    }

    fun getActiveModule(): AudioModule = activeModule

    @Synchronized
    fun updateDeepFilterConfig(config: DeepFilterConfig) {
        currentDfConfig = config
        if (dfContext != 0L) {
            dfSetAttenLim(dfContext, config.attenLimDb)
            dfSetPostFilterBeta(dfContext, config.postFilterBeta)
        }
        if (debugLog) {
            Log.d(TAG, "updateDeepFilterConfig: $config")
        }
    }

    @Synchronized
    override fun processAudio(numBands: Int, numFrames: Int, buffer: ByteBuffer) {
        if (!enable) return

        when (activeModule) {
            AudioModule.RNNOISE -> processRnnoise(numBands, numFrames, buffer)
            AudioModule.DEEP_FILTER_NET -> processDeepFilter(numBands, numFrames, buffer)
        }
    }

    private fun processRnnoise(numBands: Int, numFrames: Int, buffer: ByteBuffer) {
        if (rnnoiseContext == 0L) return

        val byteArray = ByteArray(buffer.remaining())
        buffer.get(byteArray)

        val vad = rnnoiseProcessFrame(rnnoiseContext, byteArray)

        buffer.clear()
        buffer.put(byteArray)
        buffer.flip()

        if (debugLog && vadLogs) {
            Log.d(TAG, "processRnnoise: numBands=$numBands, numFrames=$numFrames, vad=$vad")
        }
    }

    private fun processDeepFilter(numBands: Int, numFrames: Int, buffer: ByteBuffer) {
        if (dfContext == 0L) return

        val byteArray = ByteArray(buffer.remaining())
        buffer.get(byteArray)

        val outArray = dfOutputBuffer ?: return
        if (outArray.size != byteArray.size) return

        val lsnr = dfProcessFrame(dfContext, byteArray, outArray)

        buffer.clear()
        buffer.put(outArray)
        buffer.flip()

        if (debugLog && vadLogs) {
            Log.d(TAG, "processDeepFilter: numBands=$numBands, numFrames=$numFrames, lsnr=$lsnr")
        }
    }

    @Synchronized
    override fun resetAudioProcessing(newRate: Int) {
        if (debugLog) {
            Log.d(TAG, "resetAudioProcessing: newRate=$newRate")
        }

        releaseAllContexts()
        initRnnoise()
        initDeepFilter()
    }

    @Synchronized
    fun release() {
        if (debugLog) {
            Log.d(TAG, "release")
        }
        releaseAllContexts()
    }

    private fun initRnnoise() {
        if (rnnoiseContext != 0L) return
        rnnoiseContext = rnnoiseCreate()
        if (debugLog) {
            Log.d(TAG, "RNNoise initialized, context=$rnnoiseContext")
        }
    }

    private fun initDeepFilter() {
        if (dfContext != 0L) return
        val cfg = currentDfConfig
        dfContext =
                dfCreateDefault(
                        cfg.attenLimDb,
                        cfg.minDbThresh,
                        cfg.maxDbErbThresh,
                        cfg.maxDbDfThresh
                )
        if (dfContext != 0L) {
            dfFrameLength = dfGetFrameLength(dfContext)
            dfOutputBuffer = ByteArray(dfFrameLength * Float.SIZE_BYTES)
            dfSetAttenLim(dfContext, cfg.attenLimDb)
            dfSetPostFilterBeta(dfContext, cfg.postFilterBeta)
        }
        if (debugLog) {
            Log.d(TAG, "DeepFilterNet initialized, context=$dfContext, frameLength=$dfFrameLength")
        }
    }

    private fun releaseAllContexts() {
        if (rnnoiseContext != 0L) {
            rnnoiseDestroy(rnnoiseContext)
            rnnoiseContext = 0
        }
        if (dfContext != 0L) {
            dfDestroy(dfContext)
            dfContext = 0
            dfFrameLength = 0
            dfOutputBuffer = null
        }
    }

    /* ── RNNoise native methods ─────────────────────────────────────── */
    private external fun rnnoiseCreate(): Long
    private external fun rnnoiseDestroy(st: Long)
    private external fun rnnoiseProcessFrame(st: Long, pcm: ByteArray): Float

    /* ── DeepFilterNet native methods ───────────────────────────────── */
    private external fun dfCreateDefault(
            attenLimDb: Float,
            minDbThresh: Float,
            maxDbErbThresh: Float,
            maxDbDfThresh: Float
    ): Long

    private external fun dfDestroy(st: Long)
    private external fun dfGetFrameLength(st: Long): Int
    private external fun dfProcessFrame(st: Long, input: ByteArray, output: ByteArray): Float
    private external fun dfSetAttenLim(st: Long, limDb: Float)
    private external fun dfSetPostFilterBeta(st: Long, beta: Float)
}
