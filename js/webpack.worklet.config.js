import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default {
    entry: "./src/DenoiserWorklet.ts", // 入口文件
    output: {
        filename: "DenoiserWorklet.js", // 输出文件名
        path: path.resolve(__dirname, "dist"), // 输出目录
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
    mode: "production", // 生产模式
    performance: {
        hints: false, // 关闭性能提示
    },
}
