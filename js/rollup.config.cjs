const typescript = require("rollup-plugin-typescript2")
const terser = require("@rollup/plugin-terser")
const resolve = require("@rollup/plugin-node-resolve")
const commonjs = require("@rollup/plugin-commonjs")

module.exports = {
    input: "src/index.ts",
    output: [
        {
            file: "dist/index.js",
            format: "es",
            sourcemap: true,
        },
        {
            file: "dist/index.cjs",
            format: "cjs",
            exports: "named",
            sourcemap: true,
        },
        {
            file: "dist/index.umd.js",
            format: "umd",
            name: "AudioPipelinePlugin",
            sourcemap: true,
        },
    ],
    plugins: [
        resolve(),
        commonjs(),
        typescript({
            tsconfig: "tsconfig.json",
            useTsconfigDeclarationDir: true,
            clean: true,
        }),
        terser(),
    ],
}
