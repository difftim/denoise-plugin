package org.difft.android.libraries.denoise_filter

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

@RunWith(AndroidJUnit4::class)
class ExampleInstrumentedTest {
    @Test
    fun useAppContext() {
        // Context of the app under test.
        val appContext = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("org.difft.android.libraries.denoise_filter.test", appContext.packageName)

        val denoiseo = DenoisePluginAudioProcessor.getInstance(appContext)

        denoiseo.initializeAudioProcessing(48000, 1)

        // 从测试资源目录加载 PCM 文件
        val pcmFile = copyResourceToFile("bgvoice.s16le", appContext.filesDir)
        val pcmData = readPcmFile(pcmFile)

        // 将输出文件路径更改为 /sdcard/Download 目录
        val outputFile = File("/sdcard/Download", "processed_output.pcm")
        val outputFile2 = File("/sdcard/Download", "org_output.pcm")

        FileOutputStream(outputFile).use { outputStream1 ->
            FileOutputStream(outputFile2).use { outputStream2 ->
                while (pcmData.remaining() >= 960) {
                    val chunk = ByteArray(960)
                    pcmData.get(chunk) // 读取 960 字节
                    outputStream2.write(chunk) // 写入原始数据
                    denoiseo.processAudio(1, 2, ByteBuffer.wrap(chunk))
                    outputStream1.write(chunk) // 写入处理后的数据
                }
            }
        }
        println("Processed file path: ${outputFile.absolutePath}")
        println("Original file path: ${outputFile2.absolutePath}")
    }

    private fun copyResourceToFile(resourceName: String, outputDir: File): File {
        val inputStream =
            InstrumentationRegistry.getInstrumentation().context.resources.assets.open(resourceName)
        val outputFile = File(outputDir, resourceName)
        FileOutputStream(outputFile).use { outputStream ->
            inputStream.copyTo(outputStream)
        }
        inputStream.close()
        return outputFile
    }

    private fun readPcmFile(file: File): ByteBuffer {
        val inputStream = FileInputStream(file)
        val byteArray = inputStream.readBytes()
        inputStream.close()

        // 返回 ByteBuffer 而不是转换为 FloatArray
        return ByteBuffer.wrap(byteArray).order(ByteOrder.LITTLE_ENDIAN)
    }
}