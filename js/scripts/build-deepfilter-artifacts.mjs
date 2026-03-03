import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, "..", "..")

const pkgDir = path.join(repoRoot, "DeepFilterNet", "libDF", "pkg")
const srcDistDir = path.join(repoRoot, "js", "src", "dist")
const distDir = path.join(repoRoot, "js", "dist")

const bindgenSrcPath = path.join(pkgDir, "df.js")
const wasmSrcPath = path.join(pkgDir, "df_bg.wasm")

const bindgenOutPath = path.join(srcDistDir, "deepfilter-bindgen.js")
const wasmOutPath = path.join(distDir, "deepfilter.wasm")

if (!fs.existsSync(bindgenSrcPath) || !fs.existsSync(wasmSrcPath)) {
    throw new Error(
        "DeepFilterNet wasm package not found. Run `sh DeepFilterNet/scripts/build_wasm_package.sh` first.",
    )
}

fs.mkdirSync(srcDistDir, { recursive: true })
fs.mkdirSync(distDir, { recursive: true })

const bindgenSource = fs.readFileSync(bindgenSrcPath, "utf8")
const bindgenOutput = `${bindgenSource.trimEnd()}\n\nexport default wasm_bindgen\n`
fs.writeFileSync(bindgenOutPath, bindgenOutput, "utf8")

fs.copyFileSync(wasmSrcPath, wasmOutPath)

console.log("Generated DeepFilterNet worklet artifacts:")
console.log(`- ${bindgenOutPath}`)
console.log(`- ${wasmOutPath}`)
