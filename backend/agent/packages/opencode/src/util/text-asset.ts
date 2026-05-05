import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export function loadTextAsset(moduleUrl: string, relativePath: string) {
  const modulePath = fileURLToPath(moduleUrl)
  const assetPath = path.resolve(path.dirname(modulePath), relativePath)
  return fs.readFileSync(assetPath, "utf8")
}
