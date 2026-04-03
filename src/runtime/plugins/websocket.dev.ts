import { defineNuxtPlugin } from 'nuxt/app'
import { refreshNuxtData } from '#imports'

type HotEvent = (event: 'nuxt-content:update', callback: (data: { collection: string, key: string, queries: string[] }) => void) => void
export default defineNuxtPlugin(() => {
  if (!import.meta.hot || !import.meta.client) return

  import('../internal/database.client').then(({ loadDatabaseAdapter }) => {
    import('../internal/manifest').then(({ updateRuntimeManifest }) => {
      ;(import.meta.hot as unknown as { on: HotEvent }).on('nuxt-content:update', async (data) => {
        console.log('[nuxt-content] [DEBUG] Received HMR event:', data)
        if (!data || !data.collection || !Array.isArray(data.queries)) return
        try {
          const manifest = await import('#content/manifest')
          updateRuntimeManifest({
            checksums: manifest.checksums,
            checksumsStructure: manifest.checksumsStructure,
            tables: manifest.tables
          })

          const db = await loadDatabaseAdapter(data.collection)
          for (const sql of data.queries) {
            try {
              await db.exec(sql)
            }
            catch (err) {
              console.error('[nuxt-content] [DEBUG] Error applying HMR query:', err)
            }
          }
          console.log('[nuxt-content] [DEBUG] SQL queries applied, refreshing Nuxt data...')
          refreshNuxtData()
        }
        catch (e) {
          console.error('[nuxt-content] [DEBUG] HMR failed:', e)
        }
      })
    })
  })
})
