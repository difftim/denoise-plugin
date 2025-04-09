#include <jni.h>
#include "rnnoise.h"
#include "denoise.h"

// JNI function to create a DenoiseState
JNIEXPORT jlong JNICALL
Java_org_difft_android_libraries_DenoisePluginAudioProcessor_create(JNIEnv *env, jobject thizl)
{
    DenoiseState *state = rnnoise_create(NULL);
    return (jlong)state;
}

// JNI function to destroy a DenoiseState
JNIEXPORT void JNICALL
Java_org_difft_android_libraries_DenoisePluginAudioProcessor_destroy(JNIEnv *env, jobject thiz, jlong st)
{
    if (st != 0)
    {
        DenoiseState *state = (DenoiseState *)st;
        rnnoise_destroy(state);
    }
}

// JNI function to process a frame of samples
JNIEXPORT jfloat JNICALL
Java_org_difft_android_libraries_DenoisePluginAudioProcessor_processFrame(JNIEnv *env, jobject thiz, jlong st, jbyteArray pcm)
{
    if (st == 0 || pcm == NULL)
    {
        return 0.0f;
    }

    DenoiseState *state = (DenoiseState *)st;

    // Handle non-direct ByteBuffer
    jbyte *in_arr = (*env)->GetByteArrayElements(env, pcm, NULL);
    if (in_arr == NULL)
    {
        return 0.0f;
    }

    float *float_arr = (float *)in_arr;
    float result = rnnoise_process_frame(state, float_arr, float_arr);

    (*env)->ReleaseByteArrayElements(env, pcm, in_arr, 0);

    return result;
}
