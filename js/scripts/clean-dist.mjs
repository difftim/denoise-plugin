import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, "..", "dist")

const KEEP_EXTENSIONS = new Set([".wasm"])

if (!fs.existsSync(distDir)) {
    process.exit(0)
}

for (const entry of fs.readdirSync(distDir)) {
    if (KEEP_EXTENSIONS.has(path.extname(entry))) continue
    fs.rmSync(path.join(distDir, entry), { recursive: true, force: true })
}
