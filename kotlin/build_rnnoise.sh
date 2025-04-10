#!/bin/bash

# 获取当前脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 设置 Android NDK 路径
# ANDROID_NDK_ROOT=/Users/luke/Library/Android/sdk/ndk/28.0.13004108 # 修改为你的NDK路径
if [ -z "$ANDROID_NDK_ROOT" ]; then
    echo "Error: ANDROID_NDK_ROOT is not set. Please set it to your Android NDK path."
    exit 1
fi

TOOLCHAIN=$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/darwin-x86_64
SYSROOT=$TOOLCHAIN/sysroot
API=21  # 设定最低 API 版本

if command -v nproc &> /dev/null; then
    CPU_CORES=$(nproc)
else
    CPU_CORES=$(sysctl -n hw.ncpu)
fi

ENABLE_DEBUG=0
USE_LITE=1

# 目标架构配置
ARCHS=(
    "aarch64-linux-android"
    "armv7a-linux-androideabi"
    "i686-linux-android"
    "x86_64-linux-android"
)
ABIS=(
    "arm64-v8a"
    "armeabi-v7a"
    "x86"
    "x86_64"
)
CONFIGURE_FLAGS=(
    ""
    ""
    ""
    ""
)

# 创建输出目录
OUTPUT_DIR="$SCRIPT_DIR/libs"
mkdir -p $OUTPUT_DIR

# 开始编译
for ((i=0; i<${#ARCHS[@]}; i++)); do
    cd "$SCRIPT_DIR"

    TARGET=${ARCHS[i]}
    ABI=${ABIS[i]}
    BUILD_DIR="$SCRIPT_DIR/build_$ABI"

    echo "============================"
    echo "Building for $ABI..."
    echo "============================"

    # 清理旧文件
    rm -rf $BUILD_DIR
    mkdir -p $BUILD_DIR
    cd $BUILD_DIR

    # 设置交叉编译工具链
    export AR=$TOOLCHAIN/bin/llvm-ar
    export AS=$TOOLCHAIN/bin/llvm-as
    export CC=$TOOLCHAIN/bin/${TARGET}${API}-clang
    export CXX=$TOOLCHAIN/bin/${TARGET}${API}-clang++
    export LD=$TOOLCHAIN/bin/ld
    export RANLIB=$TOOLCHAIN/bin/llvm-ranlib
    export STRIP=$TOOLCHAIN/bin/llvm-strip

    OPT_FLAGS=""
    if [ $ENABLE_DEBUG -eq 1 ]; then
        OPT_FLAGS="-g -O0"
    else
        OPT_FLAGS="-O3"
    fi
    export LDFLAGS="${OPT_FLAGS}"
    export CFLAGS="${OPT_FLAGS}"
    export CXXFLAGS="${OPT_FLAGS}"

    RNNOISE_DIR="../../rnnoise"

    # 清理
    git clean -f -d $RNNOISE_DIR

    # 配置
    ../../rnnoise/autogen.sh

      # use little
    if [[ $USE_LITE == 1 ]]; then
        echo "Using lite mode"
        mv $RNNOISE_DIR/src/rnnoise_data.h $RNNOISE_DIR/src/rnnoise_data_big.h
        mv $RNNOISE_DIR/src/rnnoise_data.c $RNNOISE_DIR/src/rnnoise_data_big.c
        mv $RNNOISE_DIR/src/rnnoise_data_little.h $RNNOISE_DIR/src/rnnoise_data.h
        mv $RNNOISE_DIR/src/rnnoise_data_little.c $RNNOISE_DIR/src/rnnoise_data.c
    fi

    CONFIGURE_PARAMS="--host=$TARGET --with-sysroot=$SYSROOT --disable-static --enable-shared --disable-examples --disable-doc ${CONFIGURE_FLAGS[i]} --enable-android"
    echo "Running configure with: $RNNOISE_DIR/configure $CONFIGURE_PARAMS CFLAGS=$CFLAGS LDFLAGS=$LDFLAGS"
    $RNNOISE_DIR/configure $CONFIGURE_PARAMS CFLAGS="$CFLAGS" LDFLAGS="$LDFLAGS"

    # 编译
    make CFLAGS='${OPT_FLAGS}' librnnoise_la_LDFLAGS="-Wl,--version-script=$SCRIPT_DIR/exports.map" -j$CPU_CORES V=1

    # 复制生成的 .so 动态库
    mkdir -p $OUTPUT_DIR/$ABI
    cp .libs/librnnoise.so $OUTPUT_DIR/$ABI/

    echo "============================"
    echo "Building for $ABI... Done"
    echo "============================"

    git clean -f -d $RNNOISE_DIR
    rm -rf $BUILD_DIR

    cd "$SCRIPT_DIR"
done

echo "============================"
echo "✅ 编译完成！动态库位于 $OUTPUT_DIR"
echo "============================"
