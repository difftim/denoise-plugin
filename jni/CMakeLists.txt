cmake_minimum_required(VERSION 3.18)
project(audio_pipeline C)

set(RNNOISE_DIR "${CMAKE_SOURCE_DIR}/../rnnoise")
set(DF_LIBS_DIR "${CMAKE_SOURCE_DIR}/../kotlin/libs_df")

# ── RNNoise sources ──────────────────────────────────────────────────
set(RNNOISE_SOURCES
    ${RNNOISE_DIR}/src/denoise.c
    ${RNNOISE_DIR}/src/rnn.c
    ${RNNOISE_DIR}/src/pitch.c
    ${RNNOISE_DIR}/src/kiss_fft.c
    ${RNNOISE_DIR}/src/celt_lpc.c
    ${RNNOISE_DIR}/src/nnet.c
    ${RNNOISE_DIR}/src/nnet_default.c
    ${RNNOISE_DIR}/src/parse_lpcnet_weights.c
    ${RNNOISE_DIR}/src/rnnoise_data.c
    ${RNNOISE_DIR}/src/rnnoise_tables.c
)

# x86/x86_64: enable RTCD for SSE4.1 / AVX2 runtime dispatch
if(ANDROID_ABI STREQUAL "x86" OR ANDROID_ABI STREQUAL "x86_64")
    list(APPEND RNNOISE_SOURCES
        ${RNNOISE_DIR}/src/x86/x86cpu.c
        ${RNNOISE_DIR}/src/x86/x86_dnn_map.c
        ${RNNOISE_DIR}/src/x86/nnet_sse4_1.c
        ${RNNOISE_DIR}/src/x86/nnet_avx2.c
    )
endif()

# ── Shared library: libaudio_pipeline.so ─────────────────────────────
add_library(audio_pipeline SHARED
    ${RNNOISE_SOURCES}
    audio_pipeline_jni.c
)

target_include_directories(audio_pipeline PRIVATE
    ${RNNOISE_DIR}/include
    ${RNNOISE_DIR}/src
)

target_compile_definitions(audio_pipeline PRIVATE
    RNNOISE_BUILD
)

if(ANDROID_ABI STREQUAL "x86" OR ANDROID_ABI STREQUAL "x86_64")
    target_compile_definitions(audio_pipeline PRIVATE
        RNN_ENABLE_X86_RTCD
        CPU_INFO_BY_C
    )
endif()

target_compile_options(audio_pipeline PRIVATE -O3)

# Per-file SIMD flags for x86 RTCD sources
if(ANDROID_ABI STREQUAL "x86" OR ANDROID_ABI STREQUAL "x86_64")
    set_source_files_properties(
        ${RNNOISE_DIR}/src/x86/nnet_sse4_1.c
        PROPERTIES COMPILE_FLAGS "-msse4.1"
    )
    set_source_files_properties(
        ${RNNOISE_DIR}/src/x86/nnet_avx2.c
        PROPERTIES COMPILE_FLAGS "-mavx2 -mfma"
    )
endif()

# ── Link DeepFilterNet static library ────────────────────────────────
add_library(deepfilter STATIC IMPORTED)
set_target_properties(deepfilter PROPERTIES
    IMPORTED_LOCATION "${DF_LIBS_DIR}/${ANDROID_ABI}/libdf.a"
)

target_link_libraries(audio_pipeline
    deepfilter
    log
)

# ── Strip in release ─────────────────────────────────────────────────
set_target_properties(audio_pipeline PROPERTIES
    LINK_FLAGS "-Wl,--version-script=${CMAKE_SOURCE_DIR}/../kotlin/exports.map"
)
