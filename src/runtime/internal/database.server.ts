import type { H3Event } from 'h3'
import { isAbsolute } from 'pathe'
import type { Connector } from 'db0'
import type { ConnectorOptions as SqliteConnectorOptions } from 'db0/connectors/better-sqlite3'
import { decompressSQLDump } from './dump'
import { fetchDatabase } from './api'
import { refineContentFields } from './collection'
import type { DatabaseAdapter, RuntimeConfig } from '@nuxt/content'
import { useRuntimeManifest } from './manifest'
import adapter from '#content/adapter'
import localAdapter from '#content/local-adapter'

let db: Connector
export default function loadDatabaseAdapter(config: RuntimeConfig['content']) {
  const { database, localDatabase } = config

  if (!db) {
    if (import.meta.dev || ['nitro-prerender', 'nitro-dev'].includes(import.meta.preset as string)) {
      db = localAdapter(refineDatabaseConfig(localDatabase))
    }
    else {
      db = adapter(refineDatabaseConfig(database))
    }
  }

  return <DatabaseAdapter>{
    all: async (sql, params = []) => {
      return db.prepare(sql).all(...params)
        .then(result => (result || []).map((item: unknown) => refineContentFields(sql, item)))
    },
    first: async (sql, params = []) => {
      return db.prepare(sql).get(...params)
        .then(item => item ? refineContentFields(sql, item) : item)
    },
    exec: async (sql, params = []) => {
      return db.prepare(sql).run(...params)
    },
  }
}

const verifiedChecksums = new Map<string, string>()
const integrityCheckPromise = new Map<string, Promise<void> | null>()

export async function checkAndImportDatabaseIntegrity(event: H3Event, collection: string, config: RuntimeConfig['content']): Promise<void> {
  const { checksums, checksumsStructure } = useRuntimeManifest()
  const currentChecksum = checksums[collection]

  // If already verified with this checksum, skip further checks.
  if (verifiedChecksums.get(collection) === currentChecksum) {
    return
  }

  const promiseKey = `${collection}:${currentChecksum}`
  if (!integrityCheckPromise.has(promiseKey)) {
    const _integrityCheck = _checkAndImportDatabaseIntegrity(event, collection, checksums[collection]!, checksumsStructure[collection]!, config)
      .then((isValid) => {
        if (isValid) {
          verifiedChecksums.set(collection, currentChecksum!)
        }
        integrityCheckPromise.delete(promiseKey)
      })
      .catch((error) => {
        console.error(`[nuxt-content] Integrity check failed for ${collection}:`, error)
        integrityCheckPromise.delete(promiseKey)
      })

    integrityCheckPromise.set(promiseKey, _integrityCheck)
  }

  await integrityCheckPromise.get(promiseKey)
}

async function _checkAndImportDatabaseIntegrity(event: H3Event, collection: string, integrityVersion: string, structureIntegrityVersion: string, config: RuntimeConfig['content']) {
  const db = loadDatabaseAdapter(config)
  const { tables } = useRuntimeManifest()

  const before = await db.first<{ version: string, structureVersion: string, ready: boolean }>(`SELECT * FROM ${tables.info} WHERE id = ?`, [`checksum_${collection}`]).catch((): null => null)

  if (before?.version && !String(before.version)?.startsWith(`${config.databaseVersion}--`)) {
    await db.exec(`DROP TABLE IF EXISTS ${tables.info}`)
    before.version = ''
  }

  const unchangedStructure = before?.structureVersion === structureIntegrityVersion

  if (before?.version) {
    if (before.version === integrityVersion) {
      if (before.ready) {
        return true
      }
      await waitUntilDatabaseIsReady(db, collection)
      return true
    }

    // Update metadata but trust surgical HMR in development
    if (import.meta.dev) {
      await db.exec(`UPDATE ${tables.info} SET version = ?, structureVersion = ?, ready = true WHERE id = ?`, [integrityVersion, structureIntegrityVersion, `checksum_${collection}`])
      return true
    }

    // In production, version mismatch means we need a full update
    await db.exec(`DELETE FROM ${tables.info} WHERE id = ?`, [`checksum_${collection}`])
    if (!unchangedStructure) {
      await db.exec(`DROP TABLE IF EXISTS ${tables[collection]}`)
    }
  }

  const dump = await loadDatabaseDump(event, collection).then(decompressSQLDump)
  const dumpLinesHash = dump.map(row => row.split(' -- ').pop())
  let hashesInDb = new Set<string>()

  if (unchangedStructure) {
    const hashListFromTheDump = new Set(dumpLinesHash)
    const hashesInDbRecords = await db.all<{ __hash__: string }>(`SELECT __hash__ FROM ${tables[collection]}`).catch(() => [] as { __hash__: string }[])
    hashesInDb = new Set(hashesInDbRecords.map(r => r.__hash__))

    const hashesToDelete = new Set(Array.from(hashesInDb).filter(h => !hashListFromTheDump.has(h)))
    if (hashesToDelete.size) {
      await db.exec(`DELETE FROM ${tables[collection]} WHERE __hash__ IN (${Array(hashesToDelete.size).fill('?').join(',')})`, Array.from(hashesToDelete))
    }
  }

  await dump.reduce(async (prev: Promise<void>, sql: string, index: number) => {
    await prev

    const hash = dumpLinesHash[index]!
    const statement = sql.substring(0, sql.length - hash.length - 4)

    if (unchangedStructure) {
      if (hash === 'structure') {
        return Promise.resolve()
      }
      if (hashesInDb.has(hash)) {
        return Promise.resolve()
      }
    }

    await db.exec(statement).catch((err: Error) => {
      const message = err.message || 'Unknown error'
      console.error(`Failed to execute SQL ${sql}: ${message}`)
    })
  }, Promise.resolve())

  const after = await db.first<{ version: string }>(`SELECT version FROM ${tables.info} WHERE id = ?`, [`checksum_${collection}`]).catch(() => ({ version: '' }))
  return after?.version === integrityVersion
}

const REQUEST_TIMEOUT = 90

async function waitUntilDatabaseIsReady(db: DatabaseAdapter, collection: string) {
  let iterationCount = 0
  let interval: NodeJS.Timer
  const { tables } = useRuntimeManifest()
  await new Promise((resolve, reject) => {
    interval = setInterval(async () => {
      const row = await db.first<{ ready: boolean }>(`SELECT ready FROM ${tables.info} WHERE id = ?`, [`checksum_${collection}`])
        .catch(() => ({ ready: true }))

      if (row?.ready) {
        clearInterval(interval)
        resolve(0)
      }

      if (iterationCount++ > REQUEST_TIMEOUT) {
        clearInterval(interval)
        reject(new Error('Waiting for another database initialization timed out'))
      }
    }, 1000)
  }).catch((e) => {
    throw e
  }).finally(() => {
    if (interval) {
      clearInterval(interval)
    }
  })
}

async function loadDatabaseDump(event: H3Event, collection: string): Promise<string> {
  return await fetchDatabase(event, collection)
    .catch((e) => {
      console.error('Failed to fetch compressed dump', e)
      return ''
    })
}

function refineDatabaseConfig(config: RuntimeConfig['content']['database']) {
  if (config.type === 'd1') {
    return { ...config, bindingName: config.bindingName || config.binding }
  }

  if (config.type === 'sqlite') {
    const _config = { ...config } as SqliteConnectorOptions
    if (config.filename === ':memory:') {
      return { name: ':memory:' }
    }

    if ('filename' in config) {
      const filename = isAbsolute(config?.filename || '') || config?.filename === ':memory:'
        ? config?.filename
        : new URL(config.filename, (globalThis as unknown as { _importMeta_: { url: string } })._importMeta_.url).pathname

      _config.path = process.platform === 'win32' && filename.startsWith('/') ? filename.slice(1) : filename
    }
    return _config
  }

  if (config.type === 'pglite') {
    return {
      dataDir: config.dataDir,
      ...config,
    }
  }

  return config
}
