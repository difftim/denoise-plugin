#include <jni.h>
#include <string.h>
#include "rnnoise.h"

typedef struct DFState DFState;

extern DFState *df_create_default(float atten_lim, float min_db_thresh,
                                  float max_db_erb_thresh, float max_db_df_thresh);
extern void df_free(DFState *st);
extern size_t df_get_frame_length(DFState *st);
extern float df_process_frame(DFState *st, float *input, float *output);
extern void df_set_atten_lim(DFState *st, float lim_db);
extern void df_set_post_filter_beta(DFState *st, float beta);

#define JNI_CLASS Java_com_github_TempTalkOrg_audio_1pipeline_AudioPipelineProcessor

#define JNI_PASTE(cls, name) cls##_##name
#define JNI_EXPAND(cls, name) JNI_PASTE(cls, name)
#define JNI_FN(name) JNI_EXPAND(JNI_CLASS, name)

/* ── RNNoise ─────────────────────────────────────────────────────────── */

JNIEXPORT jlong JNICALL
JNI_FN(rnnoiseCreate)(JNIEnv *env, jobject thiz)
{
    DenoiseState *state = rnnoise_create(NULL);
    return (jlong)state;
}

JNIEXPORT void JNICALL
JNI_FN(rnnoiseDestroy)(JNIEnv *env, jobject thiz, jlong st)
{
    if (st != 0)
    {
        rnnoise_destroy((DenoiseState *)st);
    }
}

JNIEXPORT jfloat JNICALL
JNI_FN(rnnoiseProcessFrame)(JNIEnv *env, jobject thiz, jlong st, jbyteArray pcm)
{
    if (st == 0 || pcm == NULL)
        return 0.0f;

    jbyte *in_arr = (*env)->GetByteArrayElements(env, pcm, NULL);
    if (in_arr == NULL)
        return 0.0f;

    float *float_arr = (float *)in_arr;
    float result = rnnoise_process_frame((DenoiseState *)st, float_arr, float_arr);

    (*env)->ReleaseByteArrayElements(env, pcm, in_arr, 0);
    return result;
}

/* ── DeepFilterNet ───────────────────────────────────────────────────── */

JNIEXPORT jlong JNICALL
JNI_FN(dfCreateDefault)(JNIEnv *env, jobject thiz,
                 jfloat attenLimDb, jfloat minDbThresh,
                 jfloat maxDbErbThresh, jfloat maxDbDfThresh)
{
    DFState *state = df_create_default(attenLimDb, minDbThresh,
                                       maxDbErbThresh, maxDbDfThresh);
    return (jlong)state;
}

JNIEXPORT void JNICALL
JNI_FN(dfDestroy)(JNIEnv *env, jobject thiz, jlong st)
{
    if (st != 0)
    {
        df_free((DFState *)st);
    }
}

JNIEXPORT jint JNICALL
JNI_FN(dfGetFrameLength)(JNIEnv *env, jobject thiz, jlong st)
{
    if (st == 0)
        return 0;
    return (jint)df_get_frame_length((DFState *)st);
}

JNIEXPORT jfloat JNICALL
JNI_FN(dfProcessFrame)(JNIEnv *env, jobject thiz, jlong st,
                       jbyteArray input, jbyteArray output)
{
    if (st == 0 || input == NULL || output == NULL)
        return 0.0f;

    jint in_len = (*env)->GetArrayLength(env, input);
    jint out_len = (*env)->GetArrayLength(env, output);
    if (in_len != out_len)
        return 0.0f;

    jbyte *in_arr = (*env)->GetByteArrayElements(env, input, NULL);
    jbyte *out_arr = (*env)->GetByteArrayElements(env, output, NULL);
    if (in_arr == NULL || out_arr == NULL)
    {
        if (in_arr) (*env)->ReleaseByteArrayElements(env, input, in_arr, JNI_ABORT);
        if (out_arr) (*env)->ReleaseByteArrayElements(env, output, out_arr, JNI_ABORT);
        return 0.0f;
    }

    jint num_samples = in_len / (jint)sizeof(float);
    float *in_f = (float *)in_arr;
    float *out_f = (float *)out_arr;

    static const float INT16_TO_FLOAT = 1.0f / 32768.0f;
    static const float FLOAT_TO_INT16 = 32768.0f;

    for (jint i = 0; i < num_samples; i++)
        in_f[i] *= INT16_TO_FLOAT;

    float lsnr = df_process_frame((DFState *)st, in_f, out_f);

    for (jint i = 0; i < num_samples; i++)
        out_f[i] *= FLOAT_TO_INT16;

    (*env)->ReleaseByteArrayElements(env, input, in_arr, JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, output, out_arr, 0);
    return lsnr;
}

JNIEXPORT void JNICALL
JNI_FN(dfSetAttenLim)(JNIEnv *env, jobject thiz, jlong st, jfloat limDb)
{
    if (st != 0)
        df_set_atten_lim((DFState *)st, limDb);
}

JNIEXPORT void JNICALL
JNI_FN(dfSetPostFilterBeta)(JNIEnv *env, jobject thiz, jlong st, jfloat beta)
{
    if (st != 0)
        df_set_post_filter_beta((DFState *)st, beta);
}
