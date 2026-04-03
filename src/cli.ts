#!/usr/bin/env node
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { hash } from 'ohash'
import { loadNuxtConfig } from '@nuxt/kit'
// @ts-expect-error: internal imports
import { loadContentConfig } from './utils/config'
// @ts-expect-error: internal imports
import { processCollectionItems } from './utils/processor'
// @ts-expect-error: internal imports
import { initiateValidatorsContext } from './utils/dependencies'

async function main() {
  const rootDir = process.cwd()

  await initiateValidatorsContext()

  console.log(`[nuxt-content] Loading configuration from: ${rootDir}`)
  
  const nuxtConfig = await loadNuxtConfig({ cwd: rootDir })
  const options = (nuxtConfig.content || {}) as any
  
  // Default settings for local database if missing
  options._localDatabase ||= { type: 'sqlite', filename: '.data/content/contents.sqlite' }
  options.database ||= { type: 'sqlite', filename: '.data/content/contents.sqlite' }
  options.renderer ||= { alias: {} }

  // Mock Nuxt context required by the loader
  const nuxtMock = {
    options: {
      rootDir,
      dev: false,
      modules: [],
      _installedModules: [],
      _layers: [{ config: { rootDir } }]
    },
    hooks: {
      callHook: () => {},
      hook: () => {}
    }
  } as any

  const { collections } = await loadContentConfig(nuxtMock, options)
  
  const configHash = hash({
    mdcHighlight: (nuxtConfig as any).mdc?.highlight,
    contentBuild: options.build?.markdown,
  })

  console.log(`[nuxt-content] Updating ${collections.length} collections...`)
  
  const fest = await processCollectionItems(collections, options, {
    rootDir,
    configHash,
    mdc: (nuxtConfig as any).mdc,
  })

  // Update production dumps if present
  const outputPublicDir = join(rootDir, '.output', 'public', '__nuxt_content')
  if (existsSync(outputPublicDir)) {
    console.log(`[nuxt-content] Updating production dumps in ${outputPublicDir}...`)
    for (const [collection, dump] of Object.entries(fest.dump)) {
      const dumpPath = join(outputPublicDir, collection, 'sql_dump.txt')
      
      const compressedDump = gzipSync(JSON.stringify(dump)).toString('base64')
      
      if (!existsSync(join(outputPublicDir, collection))) {
        mkdirSync(join(outputPublicDir, collection), { recursive: true })
      }
      
      writeFileSync(dumpPath, compressedDump)
      console.log(`[nuxt-content] Updated compressed dump for: ${collection}`)
    }
  }

  // Write a runtime manifest file that the server can read
  const runtimeManifestDir = join(rootDir, '.data', 'content')
  if (!existsSync(runtimeManifestDir)) {
    mkdirSync(runtimeManifestDir, { recursive: true })
  }
  const runtimeManifestPath = join(runtimeManifestDir, 'manifest.json')
  
  const manifestData = {
    checksums: fest.checksum,
    checksumsStructure: fest.checksumStructure,
    tables: Object.fromEntries(collections.map(c => [c.name, c.tableName])),
  }
  
  writeFileSync(runtimeManifestPath, JSON.stringify(manifestData, null, 2))
  console.log(`[nuxt-content] Updated runtime manifest: ${runtimeManifestPath}`)

  console.log('[nuxt-content] Database synchronized successfully!')
}

main().catch(err => {
  console.error('[nuxt-content] Critical error during refresh:', err)
  process.exit(1)
})
