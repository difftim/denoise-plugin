package org.difft.android.libraries.denoise_filter

import android.util.Log
import java.nio.ByteBuffer

class DenoisePluginAudioProcessor /*private*/ constructor(
    private val debugLog: Boolean = false,
    private val vadLogs: Boolean = false
) : io.livekit.android.audio.AudioProcessorInterface {
    companion object {
        private const val TAG = "DenoiseFilter"
        private var INSTANCE: DenoisePluginAudioProcessor? = null

//        @JvmStatic
//        @Synchronized
//        fun getInstance(
//            context: android.content.Context,
//            debugLog: Boolean = false,
//            vadLogs: Boolean = false
//        ): DenoisePluginAudioProcessor {
//            if (INSTANCE == null) {
//                INSTANCE = DenoisePluginAudioProcessor(debugLog, vadLogs)
//            }
//            return INSTANCE!!
//        }

        init {
            try {
                System.loadLibrary("rnnoise")
            } catch (e: UnsatisfiedLinkError) {
                Log.e(TAG, "Error loading library: ${e.message}")
            }
        }

        private var supportSampleRateHz: Int = 48000
        private var supportNumberChannels: Int = 1
    }

    @Volatile
    private var nativeContext: Long = 0

    override fun getName(): String {
        return "denoise-filter"
    }

    @Synchronized
    override fun initializeAudioProcessing(sampleRateHz: Int, numChannels: Int) {
        if (debugLog) {
            Log.d(
                TAG,
                "initializeAudioProcessing: sampleRateHz=$sampleRateHz, numChannels=$numChannels obj=$this"
            )
        }

        if (supportSampleRateHz != sampleRateHz || supportNumberChannels != numChannels) {
            return
        }

        if (nativeContext != 0L) {
            return
        }

        nativeContext = create()
    }

    override fun isEnabled(): Boolean {
        return nativeContext != 0L
    }

    @Synchronized
    override fun processAudio(numBands: Int, numFrames: Int, buffer: ByteBuffer) {
        if (nativeContext == 0L) {
            return
        }

        val byteArray = ByteArray(buffer.remaining())
        buffer.get(byteArray)

        val vad = processFrame(nativeContext, byteArray)

        buffer.clear()
        buffer.put(byteArray)
        buffer.flip()

        if (debugLog && vadLogs) {
            Log.d(
                TAG,
                "processAudio : numBands=$numBands, numFrames=$numFrames buffer=${byteArray.size} vad=$vad"
            )
        }
    }

    @Synchronized
    override fun resetAudioProcessing(newRate: Int) {
        if (debugLog) {
            Log.d(TAG, "resetAudioProcessing : newRate=$newRate")
        }

        releaseContext()

        nativeContext = create()
    }

    @Synchronized
    fun release() {
        if (debugLog) {
            Log.d(
                TAG,
                "release: obj=$this"
            )
        }

        releaseContext()
    }

    private fun releaseContext() {
        if (nativeContext != 0L) {
            destroy(nativeContext)
            nativeContext = 0
        }
    }

    // Initialize the DenoiseState with an optional model
    private external fun create(): Long

    // Free the DenoiseState
    private external fun destroy(st: Long)

    // Denoise a frame of samples
    private external fun processFrame(st: Long, pcm: ByteArray): Float
}