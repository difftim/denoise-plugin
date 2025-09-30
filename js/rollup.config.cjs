const typescript = require("rollup-plugin-typescript2")
const terser = require("@rollup/plugin-terser")
const resolve = require("@rollup/plugin-node-resolve")
const commonjs = require("@rollup/plugin-commonjs")
const replace = require("@rollup/plugin-replace")
const fs = require("fs")
const path = require("path")

const denoiserWorkletCode = fs.readFileSync(
    path.resolve(__dirname, "dist/DenoiserWorklet.js"),
    "utf8",
)

module.exports = {
    input: "src/index.ts", // 入口文件
    output: [
        {
            file: 'dist/index.js',      // ESM
            format: 'es',
            sourcemap: true,
        },
        {
            file: 'dist/index.cjs',     // CJS
            format: 'cjs',
            exports: 'named',
            sourcemap: true,
        },
        {
            file: "dist/index.umd.js", // 输出文件
            format: "umd", // 输出格式
            name: "DenoisePlugin", // 库名称
            sourcemap: true, // 生成 sourcemap
        }
    ],
    plugins: [
        resolve(),
        commonjs(),
        typescript({
            tsconfig: "tsconfig.json",
            useTsconfigDeclarationDir: true,
            clean: true,
        }),
        replace({
            preventAssignment: true,
            "process.env.DENOISER_WORKLET": JSON.stringify(denoiserWorkletCode),
        }),
        terser(), // 压缩代码
    ],
}
