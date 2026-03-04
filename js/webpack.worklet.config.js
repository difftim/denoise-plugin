import path from "path"
import webpack from "webpack"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default {
    entry: {
        AudioPipelineWorklet: "./src/AudioPipelineWorklet.ts",
        AudioPipelineWorker: "./src/AudioPipelineWorker.ts",
    },
    target: "webworker",
    output: {
        filename: "[name].js",
        path: path.resolve(__dirname, "dist"),
        globalObject: "globalThis",
        publicPath: "",
    },
    resolve: {
        extensions: [".ts", ".js"],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: "ts-loader",
                exclude: /node_modules/,
            },
        ],
    },
    plugins: [
        new webpack.IgnorePlugin({
            resourceRegExp: /\.wasm$/,
        }),
        new webpack.BannerPlugin({
            banner: "if(typeof self==='undefined'){globalThis.self=globalThis;}",
            raw: true,
        }),
    ],
    mode: "production",
    performance: {
        hints: false,
    },
}
