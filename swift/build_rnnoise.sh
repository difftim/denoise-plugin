#!/bin/bash

# 获取当前脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 输出目录
OUTPUT_DIR="$SCRIPT_DIR/libs"
mkdir -p $OUTPUT_DIR
RELEASE_DIR="$SCRIPT_DIR/release"
mkdir -p $RELEASE_DIR

# RNNoise 源码目录
RNNOISE_DIR="$(cd "$SCRIPT_DIR/../rnnoise" && pwd)"

# 配置编译选项
ENABLE_DEBUG=0
USE_LITE=1
ENABLE_FRAMEWORK=1
ENABLE_BITCODE=0
VERSION=1.0.0

if [ $ENABLE_FRAMEWORK -eq 1 ]; then
    CONFIGURE_FLAGS="--enable-framework"
else
    CONFIGURE_FLAGS=""
fi

# 平台配置
PLATFORMS=(
    "ios"
    "ios-simulator"
    "macos"
    # "maccatalyst"
    # "tvos"
    # "tvos-simulator"
    # "xros"
    # "xros-simulator"
)
ARCHS=(
    "arm64"        # ios
    "arm64 x86_64" # ios-simulator
    "arm64 x86_64" # macos
    # "arm64 x86_64" # maccatalyst
    # "arm64" # tvos
    # "arm64 x86_64" # tvos-simulator
    # "arm64" # xros
    # "arm64 x86_64" # xros-simulator
)
SDKS=(
    "iphoneos"        # ios
    "iphonesimulator" # ios-simulator
    "macosx" # macos
    # "maccatalyst" # maccatalyst
    # "appletvos" # tvos
    # "appletvsimulator" # tvos-simulator
    # "xros" # xros
    # "xrssimulator" # xros-simulator
)

build_rnnoise() {
    cd "$SCRIPT_DIR"

    PLATFORM=$1
    ARCH=$2
    SDK=$3
    BUILD_DIR="$SCRIPT_DIR/build_${PLATFORM}_${ARCH}"

    echo "============================"
    echo "Building RNNoise for $PLATFORM ($ARCH)..."
    echo "============================"

    # 清理旧文件
    rm -rf $BUILD_DIR
    mkdir -p $BUILD_DIR
    cd $BUILD_DIR

    # 设置编译工具链
    export CC="$(xcrun --sdk $SDK --find clang)"
    export CXX="$(xcrun --sdk $SDK --find clang++)"
    export CFLAGS="-arch $ARCH -isysroot $(xcrun --sdk $SDK --show-sdk-path) -I$RNNOISE_DIR/include -DRNNOISE_EXPORT=''"
    export LDFLAGS="-arch $ARCH -isysroot $(xcrun --sdk $SDK --show-sdk-path)"

    # 添加 Bitcode 支持
    if [ $ENABLE_BITCODE -eq 1 ]; then
        CFLAGS="$CFLAGS -fembed-bitcode"
    fi

    if [ $ENABLE_DEBUG -eq 1 ]; then
        CFLAGS="$CFLAGS -g -O0"
    else
        CFLAGS="$CFLAGS -O3"
    fi

    # 清理旧文件
    git clean -f -d $RNNOISE_DIR

    # 配置
    $RNNOISE_DIR/autogen.sh

    # 使用 lite 模式
    if [[ $USE_LITE == 1 ]]; then
        echo "Using lite mode"
        mv $RNNOISE_DIR/src/rnnoise_data.h $RNNOISE_DIR/src/rnnoise_data_big.h
        mv $RNNOISE_DIR/src/rnnoise_data.c $RNNOISE_DIR/src/rnnoise_data_big.c
        mv $RNNOISE_DIR/src/rnnoise_data_little.h $RNNOISE_DIR/src/rnnoise_data.h
        mv $RNNOISE_DIR/src/rnnoise_data_little.c $RNNOISE_DIR/src/rnnoise_data.c
    fi

    $RNNOISE_DIR/configure --host=$ARCH-apple-darwin $CONFIGURE_FLAGS --disable-static --enable-shared --disable-examples --disable-doc

    # 编译
    make -j$(sysctl -n hw.ncpu)

    # 如果启用了 Framework 编译，复制 Framework
    if [ $ENABLE_FRAMEWORK -eq 1 ]; then
        FRAMEWORK_DIR="$BUILD_DIR/RNNoise.framework"
        if [ -d "$FRAMEWORK_DIR" ]; then
            mkdir -p $OUTPUT_DIR/$PLATFORM/$ARCH
            cp -R $FRAMEWORK_DIR $OUTPUT_DIR/$PLATFORM/$ARCH/
            echo "✅ Framework copied to $OUTPUT_DIR/$PLATFORM/$ARCH/"
        else
            echo "❌ Error: Framework not found at $FRAMEWORK_DIR"
            exit 1
        fi
    fi

    git clean -f -d $RNNOISE_DIR
    rm -rf $BUILD_DIR

    cd "$SCRIPT_DIR"
}

combine_framework_archs() {
    PLATFORM=$1
    OUTPUT_DIR_PLATFORM="$OUTPUT_DIR/$PLATFORM"
    COMBINED_FRAMEWORK="$OUTPUT_DIR_PLATFORM/RNNoise.framework"

    echo "============================"
    echo "Combining architectures for $PLATFORM into a single framework..."
    echo "============================"

    # Create the combined framework directory
    mkdir -p "$COMBINED_FRAMEWORK"
    cp -R "$OUTPUT_DIR_PLATFORM/arm64/RNNoise.framework/"* "$COMBINED_FRAMEWORK/"

    # Collect all architectures for the platform
    INPUT_LIBS=()
    for ARCH in ${ARCHS[$2]}; do
        INPUT_LIBS+=("$OUTPUT_DIR_PLATFORM/$ARCH/RNNoise.framework/RNNoise")
    done

    # Combine the libraries into a single binary
    lipo -create "${INPUT_LIBS[@]}" -output "$COMBINED_FRAMEWORK/RNNoise"

    echo "✅ Combined framework created at $COMBINED_FRAMEWORK"
}

# 创建 XCFramework
create_xcframework() {
    echo "============================"
    echo "Creating XCFramework..."
    echo "============================"

    # 输出 XCFramework 路径
    XCFRAMEWORK_OUTPUT="$OUTPUT_DIR/RNNoise.xcframework"
    rm -rf $XCFRAMEWORK_OUTPUT

    # 构建 XCFramework 参数
    XCFRAMEWORK_ARGS=()
    for ((i = 0; i < ${#PLATFORMS[@]}; i++)); do
        PLATFORM="${PLATFORMS[i]}"
        FRAMEWORK_PATH="$OUTPUT_DIR/$PLATFORM/RNNoise.framework"
        XCFRAMEWORK_ARGS+=("-framework $FRAMEWORK_PATH")
    done

    # 创建 XCFramework
    echo "xcodebuild -create-xcframework ${XCFRAMEWORK_ARGS[@]} -output $XCFRAMEWORK_OUTPUT"
    xcodebuild -create-xcframework ${XCFRAMEWORK_ARGS[@]} -output $XCFRAMEWORK_OUTPUT

    echo "============================"
    echo "✅ XCFramework 创建完成！路径: $XCFRAMEWORK_OUTPUT"
    echo "============================"
}

# 压缩 XCFramework
compress_xcframework() {
    echo "============================"
    echo "Compressing XCFramework..."
    echo "============================"

    ZIP_OUTPUT="$RELEASE_DIR/RNNoise.xcframework.zip"
    rm -f $ZIP_OUTPUT
    cd $OUTPUT_DIR
    zip -r $ZIP_OUTPUT RNNoise.xcframework

    echo "✅ XCFramework 压缩完成！路径: $ZIP_OUTPUT Checksum: $Checksum"
    echo "Checksum: $(swift package compute-checksum $ZIP_OUTPUT)"
    echo "============================"
}

# 编译所有平台和架构
for ((i = 0; i < ${#PLATFORMS[@]}; i++)); do
    PLATFORM="${PLATFORMS[i]}"
    ARCH_LIST="${ARCHS[i]}"
    SDK="${SDKS[i]}"

    for ARCH in $ARCH_LIST; do
        build_rnnoise "$PLATFORM" "$ARCH" "$SDK"
    done

    combine_framework_archs "$PLATFORM" "$i"
done

# 创建 XCFramework
create_xcframework

# 压缩 XCFramework
compress_xcframework

echo "============================"
echo "✅ 编译完成！Framework 和 XCFramework 位于 $OUTPUT_DIR"
echo "============================"
