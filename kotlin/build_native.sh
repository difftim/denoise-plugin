#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RNNOISE_DIR="$PROJECT_ROOT/rnnoise"
JNI_DIR="$PROJECT_ROOT/jni"
OUTPUT_DIR="$SCRIPT_DIR/libs"

if [ -z "$ANDROID_NDK_ROOT" ]; then
    echo "Error: ANDROID_NDK_ROOT is not set."
    exit 1
fi

USE_LITE=1

# ── Step 1: Build DeepFilterNet static libs ──────────────────────────
echo "============================"
echo "Step 1: Building DeepFilterNet..."
echo "============================"
bash "$SCRIPT_DIR/build_deepfilter.sh"

# ── Step 2: Prepare RNNoise sources (extract model + use lite) ────────
echo "============================"
echo "Step 2: Preparing RNNoise sources..."
echo "============================"

cd "$RNNOISE_DIR"

MODEL_HASH=$(cat model_version)
MODEL_TAR="rnnoise_data-${MODEL_HASH}.tar.gz"

if [ ! -f "src/rnnoise_data.c" ] || [ ! -f "src/rnnoise_data.h" ]; then
    if [ -f "$MODEL_TAR" ]; then
        echo "Extracting model weights from $MODEL_TAR"
        tar xf "$MODEL_TAR"
    else
        echo "Error: rnnoise_data.c not found and model archive $MODEL_TAR is missing."
        echo "Run rnnoise/download_model.sh first."
        exit 1
    fi
fi

if [ -f src/rnnoise_data_little.c ] && [ -f src/rnnoise_data_little.h ] && [ "$USE_LITE" = "1" ]; then
    echo "Using lite RNNoise model"
    cp src/rnnoise_data.h src/rnnoise_data_big.h.bak
    cp src/rnnoise_data.c src/rnnoise_data_big.c.bak
    cp src/rnnoise_data_little.h src/rnnoise_data.h
    cp src/rnnoise_data_little.c src/rnnoise_data.c
fi

# ── Step 3: Build unified .so with CMake + NDK ──────────────────────
echo "============================"
echo "Step 3: Building libaudio_pipeline.so..."
echo "============================"

ABIS=("arm64-v8a" "armeabi-v7a" "x86" "x86_64")

CMAKE_TOOLCHAIN="$ANDROID_NDK_ROOT/build/cmake/android.toolchain.cmake"

if [ ! -f "$CMAKE_TOOLCHAIN" ]; then
    echo "Error: NDK CMake toolchain not found at $CMAKE_TOOLCHAIN"
    exit 1
fi

mkdir -p "$OUTPUT_DIR"

for ABI in "${ABIS[@]}"; do
    echo "--- Building for $ABI ---"

    BUILD_DIR="$SCRIPT_DIR/build_cmake_$ABI"
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"

    cmake -S "$JNI_DIR" -B "$BUILD_DIR" \
        -DCMAKE_TOOLCHAIN_FILE="$CMAKE_TOOLCHAIN" \
        -DANDROID_ABI="$ABI" \
        -DANDROID_PLATFORM=android-21 \
        -DCMAKE_BUILD_TYPE=Release

    cmake --build "$BUILD_DIR" --config Release -j "$(nproc 2>/dev/null || sysctl -n hw.ncpu)"

    mkdir -p "$OUTPUT_DIR/$ABI"
    cp "$BUILD_DIR/libaudio_pipeline.so" "$OUTPUT_DIR/$ABI/"

    rm -rf "$BUILD_DIR"

    echo "--- Done: $ABI ---"
done

# ── Step 4: Clean up RNNoise generated/extracted files ───────────────
cd "$RNNOISE_DIR"
rm -f src/rnnoise_data_big.h.bak src/rnnoise_data_big.c.bak
rm -f src/rnnoise_data.c src/rnnoise_data.h
rm -f src/rnnoise_data_little.c src/rnnoise_data_little.h
rm -f models/*.pth
echo "Cleaned up extracted RNNoise files"

echo "============================"
echo "Build complete! Libraries at $OUTPUT_DIR"
echo "============================"
ls -la "$OUTPUT_DIR"/*/libaudio_pipeline.so
