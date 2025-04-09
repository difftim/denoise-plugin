package org.difft.android.libraries

import java.nio.ByteBuffer
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteOrder

public final class DenoisePluginAudioProcessor private constructor() : io.livekit.android.audio.AudioProcessorInterface {
    public companion object {
        private final var INSTANCE: DenoisePluginAudioProcessor? = null

        @kotlin.jvm.JvmStatic public final fun getInstance(context: android.content.Context): DenoisePluginAudioProcessor { return DenoisePluginAudioProcessor() }

        private var supportSampleRateHz :Int = 48000
        private var supportNumberChannels :Int = 1
    }

    private var nativeContext :Long = 0

    init {
        try {
            System.loadLibrary("rnnoise")
        } catch (e: UnsatisfiedLinkError) {
            // Handle the error appropriately, e.g., log it or throw a custom exception
            println("Error loading rnnoise library: ${e.message}")
            // You might want to disable the denoise feature or use a fallback mechanism here.
        }
    }

    override fun getName(): String {
        return "denoise-filter"
    }

    override fun initializeAudioProcessing(sampleRateHz: Int, numChannels: Int) {
        println("DenoisePluginAudioProcessor: initializeAudioProcessing : sampleRateHz=$sampleRateHz, numChannels=$numChannels")

        if(supportSampleRateHz != sampleRateHz || supportNumberChannels != numChannels) {
            return
        }

        if (nativeContext != 0L){
            return
        }

        nativeContext = create()
    }

    override fun isEnabled(): Boolean {
        return nativeContext != 0L
    }

    override fun processAudio(numBands: Int, numFrames: Int, buffer: ByteBuffer) {
        if (nativeContext == 0L) {
            return
        }

        // 将 ByteBuffer 转换为 ByteArray
        val byteArray = ByteArray(buffer.remaining())
        buffer.get(byteArray)

        // 调用 processFrame
        val vad = processFrame(nativeContext, byteArray)

        // 将处理后的 byteArray 写回到 buffer
        buffer.clear()
        buffer.put(byteArray)
        buffer.flip() // 准备读取

        println("DenoisePluginAudioProcessor: processAudio : numBands=$numBands, numFrames=$numFrames buffer=${byteArray.size} vad=$vad")
    }

    override fun resetAudioProcessing(newRate: Int) {
        println("DenoisePluginAudioProcessor: resetAudioProcessing : newRate=$newRate")

        if (nativeContext != 0L){
            destroy(nativeContext)
            nativeContext = 0
        }

        nativeContext = create()
    }

    // Initialize the DenoiseState with an optional model
    private external fun create(): Long

    // Free the DenoiseState
    private external fun destroy(st: Long)

    // Denoise a frame of samples
    private external fun processFrame(st: Long, pcm: ByteArray): Float

}