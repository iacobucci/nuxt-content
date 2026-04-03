import { defineNuxtPlugin } from 'nuxt/app'
import { refreshNuxtData } from '#imports'

type HotEvent = (event: 'nuxt-content:update', callback: (data: { collection: string, key: string, queries: string[], checksums: Record<string, string>, checksumsStructure: Record<string, string> }) => void) => void
export default defineNuxtPlugin(() => {
  if (!import.meta.hot || !import.meta.client) return

  import('../internal/database.client').then(({ loadDatabaseAdapter }) => {
    import('../internal/manifest').then(({ updateRuntimeManifest }) => {
      ;(import.meta.hot as unknown as { on: HotEvent }).on('nuxt-content:update', async (data) => {
        if (!data || !data.collection || !Array.isArray(data.queries)) return
        try {
          const manifest = await import('#content/manifest')
          updateRuntimeManifest({
            checksums: data.checksums || manifest.checksums,
            checksumsStructure: data.checksumsStructure || manifest.checksumsStructure,
            tables: manifest.tables
          })

          const db = await loadDatabaseAdapter(data.collection)
          for (const sql of data.queries) {
            try {
              await db.exec(sql)
            }
            catch (err) {
              console.error('[nuxt-content] Error applying HMR query:', err)
            }
          }
          refreshNuxtData()
        }
        catch (e) {
          console.error('[nuxt-content] HMR failed:', e)
        }
      })
    })
  })
})
