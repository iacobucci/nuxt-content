import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'pathe'
import { checksums as staticChecksums, checksumsStructure as staticChecksumsStructure, tables as staticTables } from '#content/manifest'

let runtimeManifest: any = null
let lastManifestLoad = 0

export function useRuntimeManifest() {
  // In dev mode, we always prefer the static manifest from Nuxt HMR
  if (import.meta.dev) {
    return runtimeManifest || {
      checksums: staticChecksums,
      checksumsStructure: staticChecksumsStructure,
      tables: staticTables
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
    checksums: staticChecksums,
    checksumsStructure: staticChecksumsStructure,
    tables: staticTables
  }
}

export function setRuntimeManifest(manifest: any) {
  runtimeManifest = manifest
}
