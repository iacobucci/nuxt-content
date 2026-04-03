import { hash } from 'ohash'
import { join } from 'pathe'
import type { Nuxt } from '@nuxt/schema'
import type { ResolvedCollection, ModuleOptions, ParsedContentFile } from '../types'
import { generateCollectionInsert, generateCollectionTableDefinition } from './collection'
import { parseSourceBase } from './source'
import { databaseVersion, getLocalDatabase } from './database'
import { createParser } from './content'
import { getContentChecksum, chunks, logger } from './common'

export async function processCollectionItems(
  collections: ResolvedCollection[],
  options: ModuleOptions,
  context: {
    rootDir: string
    configHash: string
    buildMarkdown?: unknown
    mdc?: unknown
  },
  onUpdate?: (manifest: unknown) => Promise<void>,
) {
  const collectionDump: Record<string, string[]> = {}
  const collectionChecksum: Record<string, string> = {}
  const collectionChecksumStructure: Record<string, string> = {}
  const db = await getLocalDatabase(options._localDatabase!, {
    sqliteConnector: options.experimental?.sqliteConnector || (options.experimental?.nativeSqlite ? 'native' : undefined),
  })
  const databaseContents = await db.fetchDevelopmentCache()

  const infoCollection = collections.find(c => c.name === 'info')!

  const startTime = performance.now()
  let filesCount = 0
  let cachedFilesCount = 0
  let parsedFilesCount = 0

  const usedComponents: Array<string> = []

  await db.dropContentTables()

  for await (const collection of collections) {
    if (collection.name === 'info') {
      continue
    }
    const collectionHash = hash(collection)
    const collectionQueries = generateCollectionTableDefinition(collection, { drop: true })
      .split('\n').map(q => `${q} -- structure`)

    if (!collection.source) {
      continue
    }

    // We pass a mock Nuxt object or refactor createParser to take what it needs
    // @ts-expect-error: Mocking Nuxt object is easier than full refactoring for this purpose
    const parse = await createParser(collection, {
      options: {
        rootDir: context.rootDir,
        content: options,
        mdc: context.mdc,
      },
    } as unknown as Nuxt)

    const structureVersion = collectionChecksumStructure[collection.name] = hash(collectionQueries)

    for await (const collectionSource of collection.source || []) {
      if (collectionSource.prepare) {
        // @ts-expect-error: Accessing private __rootDir property
        const rootDir = collection.__rootDir || context.rootDir
        await collectionSource.prepare({ rootDir })
      }

      const { fixed } = parseSourceBase(collectionSource)
      const cwd = collectionSource.cwd
      // @ts-expect-error: getKeys is an optional property that might exist on some sources
      const _keys = await collectionSource.getKeys?.() || []

      filesCount += _keys.length

      const list: Array<[string, Array<string>, string]> = []
      for await (const chunk of chunks(_keys, 25)) {
        await Promise.all(chunk.map(async (key) => {
          const keyInCollection = join(collection.name, collectionSource?.prefix || '', key)
          const fullPath = join(cwd, fixed, key)
          const cache = databaseContents[keyInCollection]

          try {
            // @ts-expect-error: getItem is an optional property that might exist on some sources
            const content = await collectionSource.getItem?.(key) || ''
            const checksum = getContentChecksum(context.configHash + collectionHash + content)

            let parsedContent: ParsedContentFile
            if (cache && cache.checksum === checksum) {
              cachedFilesCount += 1
              parsedContent = JSON.parse(cache.value)
            }
            else {
              parsedFilesCount += 1
              parsedContent = await parse({
                id: keyInCollection,
                body: content,
                path: fullPath,
                collectionType: collection.type,
              })
              if (parsedContent) {
                await db.insertDevelopmentCache(keyInCollection, JSON.stringify(parsedContent), checksum)
              }
            }

            if (parsedContent?.__metadata?.components) {
              usedComponents.push(...parsedContent.__metadata.components)
            }

            const { queries, hash: qHash } = generateCollectionInsert(collection, parsedContent)
            list.push([key, queries, qHash])
          }
          catch (e: unknown) {
            logger.warn(`"${keyInCollection}" is ignored because parsing is failed. Error: ${e instanceof Error ? e.message : 'Unknown error'}`)
          }
        }))
      }

      list.sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      collectionQueries.push(...list.flatMap(([, sql, qHash]) => sql.map(q => `${q} -- ${qHash}`)))
    }

    const version = collectionChecksum[collection.name] = `${databaseVersion}--${hash(collectionQueries)}`

    collectionDump[collection.name] = [
      `${generateCollectionTableDefinition(infoCollection, { drop: false })} -- structure`,
      ...generateCollectionInsert(infoCollection, { id: `checksum_${collection.name}`, version, structureVersion, ready: false }).queries.map(row => `${row} -- meta`),
      ...collectionQueries,
      `UPDATE ${infoCollection.tableName} SET ready = true WHERE id = 'checksum_${collection.name}'; -- meta`,
    ]
  }

  const sqlDumpList = Object.values(collectionDump).flatMap(a => a)
  await db.exec(`DROP TABLE IF EXISTS ${infoCollection.tableName}`)

  try {
    if (db.supportsTransactions) {
      await db.exec('BEGIN TRANSACTION')
    }
    for (const sql of sqlDumpList) {
      await db.exec(sql)
    }
    if (db.supportsTransactions) {
      await db.exec('COMMIT')
    }
  }
  catch (error) {
    if (db.supportsTransactions) {
      try {
        await db.exec('ROLLBACK')
      }
      catch {
        // ignore
      }
    }
    throw error
  }

  const tags = sqlDumpList.flatMap((sql: string): RegExpMatchArray | [] => sql.match(/(?<=(^|,|\[)\[")[^"]+(?=")/g) || [])
  const allComponents = [
    ...Object.values(options.renderer.alias || {}),
    ...new Set(tags),
    ...new Set(usedComponents),
  ]

  const endTime = performance.now()
  logger.success(`Processed ${collections.length} collections and ${filesCount} files in ${(endTime - startTime).toFixed(2)}ms (${cachedFilesCount} cached, ${parsedFilesCount} parsed)`)

  const result = {
    checksumStructure: collectionChecksumStructure,
    checksum: collectionChecksum,
    dump: collectionDump,
    components: allComponents,
  }

  if (onUpdate) {
    await onUpdate(result)
  }

  return result
}
