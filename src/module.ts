import { stat } from 'node:fs/promises'
import {
  defineNuxtModule,
  createResolver,
  addTemplate,
  addTypeTemplate,
  addImports,
  addServerImports,
  addPlugin,
  hasNuxtModule,
  updateTemplates,
  addComponent,
  installModule,
  addVitePlugin,
} from '@nuxt/kit'
import type { ModuleOptions as MDCModuleOptions } from '@nuxtjs/mdc'
import { hash } from 'ohash'
import htmlTags from '@nuxtjs/mdc/runtime/parser/utils/html-tags-list'
import { kebabCase, pascalCase } from 'scule'
import defu from 'defu'
import { version } from '../package.json'
import { componentsManifestTemplate, contentTypesTemplate, fullDatabaseRawDumpTemplate, manifestTemplate, moduleTemplates } from './utils/templates'
import type { ModuleOptions } from './types/module'
import { NuxtContentHMRUnplugin } from './utils/dev'
import { loadContentConfig } from './utils/config'
import { configureMDCModule } from './utils/mdc'
import { findPreset } from './presets'
import type { Manifest } from './types/manifest'
import { setupPreview, setupPreviewWithAPI, shouldEnablePreview } from './utils/preview/module'
import { databaseVersion, refineDatabaseConfig, resolveDatabaseAdapter } from './utils/database'
import { initiateValidatorsContext } from './utils/dependencies'
import { processCollectionItems } from './utils/processor'

// Export public utils
export * from './utils'
export type * from './types'

const moduleDefaults: Partial<ModuleOptions> = {
  _localDatabase: {
    type: 'sqlite',
    filename: '.data/content/contents.sqlite',
  },
  preview: {},
  watch: { enabled: true },
  renderer: {
    alias: {},
    anchorLinks: {
      h2: true,
      h3: true,
      h4: true,
    },
  },
  build: {
    pathMeta: {},
    markdown: {},
    yaml: {},
    csv: {
      delimiter: ',',
      json: true,
    },
  },
  experimental: {
    nativeSqlite: false,
  },
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@nuxt/content',
    configKey: 'content',
    version,
    compatibility: {
      nuxt: '>=4.1.0 || ^3.19.0',
    },
    docs: 'https://content.nuxt.com',
  },
  defaults: moduleDefaults,
  moduleDependencies(nuxt) {
    const nuxtOptions = nuxt.options as unknown as { content: ModuleOptions }
    const contentOptions = defu(nuxtOptions.content, moduleDefaults)

    return {
      '@nuxtjs/mdc': {
        overrides: {
          highlight: contentOptions.build?.markdown?.highlight,
          components: {
            prose: true,
            map: contentOptions.renderer.alias,
          },
          headings: {
            anchorLinks: contentOptions.renderer.anchorLinks,
          },
          remarkPlugins: contentOptions.build?.markdown?.remarkPlugins,
          rehypePlugins: contentOptions.build?.markdown?.rehypePlugins,
        },
        defaults: {
          highlight: { noApiRoute: true },
        },
      },
    }
  },
  async setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)
    const manifest: Manifest = {
      checksumStructure: {},
      checksum: {},
      dump: {},
      components: [],
      collections: [],
    }

    // Detect installed validators and them into content context
    await initiateValidatorsContext()

    const { collections } = await loadContentConfig(nuxt, options)
    manifest.collections = collections

    nuxt.options.vite.optimizeDeps = defu(nuxt.options.vite.optimizeDeps, {
      exclude: ['@sqlite.org/sqlite-wasm'],
    })

    // Ignore content directory files in building
    nuxt.options.ignore = [...(nuxt.options.ignore || []), 'content/**']

    // Helpers are designed to be enviroment agnostic
    addImports([
      { name: 'queryCollection', from: resolver.resolve('./runtime/client') },
      { name: 'queryCollectionSearchSections', from: resolver.resolve('./runtime/client') },
      { name: 'queryCollectionNavigation', from: resolver.resolve('./runtime/client') },
      { name: 'queryCollectionItemSurroundings', from: resolver.resolve('./runtime/client') },
    ])
    addServerImports([
      { name: 'queryCollection', from: resolver.resolve('./runtime/nitro') },
      { name: 'queryCollectionSearchSections', from: resolver.resolve('./runtime/nitro') },
      { name: 'queryCollectionNavigation', from: resolver.resolve('./runtime/nitro') },
      { name: 'queryCollectionItemSurroundings', from: resolver.resolve('./runtime/nitro') },
    ])
    addComponent({ name: 'ContentRenderer', filePath: resolver.resolve('./runtime/components/ContentRenderer.vue') })

    // Add Templates & aliases
    addTemplate(fullDatabaseRawDumpTemplate(manifest))
    nuxt.options.alias = defu(nuxt.options.alias, {
      '#content/components': addTemplate(componentsManifestTemplate(manifest)).dst,
      '#content/manifest': addTemplate(manifestTemplate(manifest)).dst,
    })

    // Add content types to Nuxt and Nitro
    const typesTemplateDst = addTypeTemplate(contentTypesTemplate(manifest.collections)).dst
    nuxt.options.nitro.typescript = defu(nuxt.options.nitro.typescript, {
      tsConfig: {
        include: [typesTemplateDst],
      },
    })

    // Register user components
    const _layers = [...nuxt.options._layers].reverse()
    for (const layer of _layers) {
      const path = resolver.resolve(layer.config.srcDir, 'components/content')
      const dirStat = await stat(path).catch((): null => null)
      if (dirStat && dirStat.isDirectory()) {
        nuxt.hook('components:dirs', (dirs) => {
          dirs.unshift({ path, pathPrefix: false, prefix: '' })
        })
      }
    }

    // Prerender database.sql routes for each collection to fetch dump
    nuxt.options.routeRules ||= {}

    nuxt.options.routeRules![`/__nuxt_content/**`] = {
      ...nuxt.options.routeRules![`/__nuxt_content/**`],
      // @ts-expect-error - Prevent nuxtseo from indexing nuxt-content routes
      robots: false,
      cache: false,
    }

    manifest.collections.forEach((collection) => {
      if (!collection.private) {
        const key = `/__nuxt_content/${collection.name}/sql_dump.txt`
        nuxt.options.routeRules![key] = { ...nuxt.options.routeRules![key], prerender: true }
      }
    })

    nuxt.hook('nitro:config', async (config) => {
      const preset = findPreset(nuxt)
      await preset.setupNitro(config, { manifest, resolver, moduleOptions: options, nuxt })

      const resolveOptions = { resolver, sqliteConnector: options.experimental?.sqliteConnector || (options.experimental?.nativeSqlite ? 'native' : undefined) }
      config.alias ||= {}
      config.alias['#content/adapter'] = await resolveDatabaseAdapter(config.runtimeConfig!.content!.database?.type || options.database.type, resolveOptions)
      config.alias['#content/local-adapter'] = await resolveDatabaseAdapter(options._localDatabase!.type || 'sqlite', resolveOptions)

      config.handlers ||= []
      manifest.collections.forEach((collection) => {
        config.handlers!.push({
          route: `/__nuxt_content/${collection.name}/query`,
          handler: resolver.resolve('./runtime/api/query.post'),
        })
      })

      // Handle HMR changes
      if (nuxt.options.dev && options.watch?.enabled !== false) {
        addPlugin({ src: resolver.resolve('./runtime/plugins/websocket.dev'), mode: 'client' })
        addVitePlugin(NuxtContentHMRUnplugin.vite({
          nuxt,
          moduleOptions: options,
          manifest,
        }))
      }
    })

    if (hasNuxtModule('nuxt-llms')) {
      installModule(resolver.resolve('./features/llms'))
    }

    await configureMDCModule(options, nuxt)

    nuxt.hook('modules:done', async () => {
      const preset = findPreset(nuxt)
      await preset?.setup?.(options, nuxt, { resolver, manifest })
      // Provide default database configuration here since nuxt is merging defaults and user options
      options.database ||= { type: 'sqlite', filename: './contents.sqlite' }
      await refineDatabaseConfig(options._localDatabase, { rootDir: nuxt.options.rootDir, updateSqliteFileName: true })
      await refineDatabaseConfig(options.database, { rootDir: nuxt.options.rootDir })

      // Module Options
      nuxt.options.runtimeConfig.public.content = {
        wsUrl: '',
      }
      nuxt.options.runtimeConfig.content = {
        databaseVersion,
        version,
        database: options.database,
        localDatabase: options._localDatabase!,
        integrityCheck: true,
        processorPath: resolver.resolve('./utils/processor'),
        configPath: resolver.resolve('./utils/config'),
        _layers: nuxt.options._layers.map(l => ({ config: { rootDir: l.config.rootDir } })),
        mdc: (nuxt.options as unknown as { mdc: MDCModuleOptions }).mdc,
      } as never
    })

    if (nuxt.options._prepare) {
      return
    }

    // Generate collections and sql dump to update templates local database
    // `modules:done` is triggered for all environments
    nuxt.hook('modules:done', async () => {
      const configHash = hash({
        mdcHighlight: (nuxt.options as unknown as { mdc: MDCModuleOptions }).mdc?.highlight,
        contentBuild: options.build?.markdown,
      })
      const fest = await processCollectionItems(manifest.collections, options, {
        rootDir: nuxt.options.rootDir,
        configHash,
        mdc: (nuxt.options as unknown as { mdc: MDCModuleOptions }).mdc,
      })

      // Update manifest
      manifest.checksumStructure = fest.checksumStructure
      manifest.checksum = fest.checksum
      manifest.dump = fest.dump
      manifest.components = fest.components.map(tag => getMappedTag(tag, options?.renderer?.alias))
        .filter(tag => !htmlTags.has(kebabCase(tag)))
        .map(tag => pascalCase(tag))

      await updateTemplates({
        filter: template => [
          moduleTemplates.fullRawDump,
          moduleTemplates.fullCompressedDump,
          moduleTemplates.manifest,
          moduleTemplates.components,
        ].includes(template.filename),
      })

      // Handle preview mode
      if (hasNuxtModule('nuxt-studio')) {
        await setupPreview(options, nuxt, resolver, manifest)
      }
      if (shouldEnablePreview(nuxt, options)) {
        await setupPreviewWithAPI(options, nuxt, resolver, manifest)
      }
    })
  },
})

const proseTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'strong', 'em', 's', 'code', 'span', 'blockquote', 'pre', 'hr', 'img', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td']
function getMappedTag(tag: string, additionalTags: Record<string, string> = {}) {
  if (proseTags.includes(tag)) {
    return `prose-${tag}`
  }
  return additionalTags[tag] || tag
}
