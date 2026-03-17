#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DF_DIR="$(cd "$SCRIPT_DIR/../DeepFilterNet/libDF" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/libs_df"

if [ -z "$ANDROID_NDK_ROOT" ]; then
    echo "Error: ANDROID_NDK_ROOT is not set."
    exit 1
fi

if ! command -v cargo-ndk &> /dev/null; then
    echo "Error: cargo-ndk not found. Install with: cargo install cargo-ndk"
    exit 1
fi

RUST_TARGETS=(
    "aarch64-linux-android"
    "armv7-linux-androideabi"
    "i686-linux-android"
    "x86_64-linux-android"
)
ABIS=(
    "arm64-v8a"
    "armeabi-v7a"
    "x86"
    "x86_64"
)

for target in "${RUST_TARGETS[@]}"; do
    rustup target add "$target" 2>/dev/null || true
done

mkdir -p "$OUTPUT_DIR"
for abi in "${ABIS[@]}"; do
    mkdir -p "$OUTPUT_DIR/$abi"
done

echo "============================"
echo "Building DeepFilterNet for Android..."
echo "============================"

cd "$DF_DIR"

for ((i=0; i<${#RUST_TARGETS[@]}; i++)); do
    TARGET=${RUST_TARGETS[i]}
    ABI=${ABIS[i]}

    echo "--- Building for $ABI ($TARGET) ---"

    CARGO_ENCODED_RUSTFLAGS="-Clinker-plugin-lto=no" \
    cargo ndk \
        --target "$TARGET" \
        --platform 21 \
        -- build \
        --release \
        --lib \
        --features "capi,default-model"

    TARGET_DIR="$DF_DIR/../target/$TARGET/release"

    if [ -f "$TARGET_DIR/libdf.a" ]; then
        cp "$TARGET_DIR/libdf.a" "$OUTPUT_DIR/$ABI/"
    elif [ -f "$TARGET_DIR/libdeep_filter.a" ]; then
        cp "$TARGET_DIR/libdeep_filter.a" "$OUTPUT_DIR/$ABI/libdf.a"
    else
        echo "Error: static library not found for $ABI in $TARGET_DIR"
        ls -la "$TARGET_DIR"/lib* 2>/dev/null || true
        exit 1
    fi

    echo "--- Done: $ABI ---"
done

echo "============================"
echo "DeepFilterNet build complete! Static libs at $OUTPUT_DIR"
echo "============================"
