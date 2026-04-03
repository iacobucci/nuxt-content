import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'pathe'
import * as staticManifest from '#content/manifest'

let runtimeManifest: any = null
let lastManifestLoad = 0

export function useRuntimeManifest() {
  // In dev mode, we use getters to stay in sync with Vite HMR
  if (import.meta.dev) {
    if (runtimeManifest) {
      return runtimeManifest
    }
    return {
      get checksums() { return (staticManifest as any).checksums },
      get checksumsStructure() { return (staticManifest as any).checksumsStructure },
      get tables() { return (staticManifest as any).tables }
    }
  }

  if (import.meta.server && !import.meta.prerender) {
    try {
      const rootDir = process.cwd()
      const manifestPath = join(rootDir, '.data/content/manifest.json')

      if (existsSync(manifestPath)) {
        const stats = statSync(manifestPath)
        const mtime = stats.mtimeMs

        if (mtime > lastManifestLoad) {
          const data = JSON.parse(readFileSync(manifestPath, 'utf8'))
          runtimeManifest = data
          lastManifestLoad = mtime
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // Production: prefer manual override or disk-loaded manifest
  if (runtimeManifest) {
    return runtimeManifest
  }

  // Fallback to static manifest
  return {
    checksums: (staticManifest as any).checksums,
    checksumsStructure: (staticManifest as any).checksumsStructure,
    tables: (staticManifest as any).tables
  }
}

export function setRuntimeManifest(manifest: any) {
  runtimeManifest = manifest
}

export function updateRuntimeManifest(manifest: any) {
  runtimeManifest = manifest
  lastManifestLoad = Date.now()
}
