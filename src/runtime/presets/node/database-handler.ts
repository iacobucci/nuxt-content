import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { eventHandler, getRouterParam, setHeader } from 'h3'
import { useStorage } from 'nitropack/runtime'

export default eventHandler(async (event) => {
  const collection = getRouterParam(event, 'collection')! || event.path?.split('/')?.[2] || ''
  setHeader(event, 'Content-Type', 'text/plain')

  // Check for runtime updated dump first in the output directory
  try {
    const rootDir = process.cwd()
    const dumpPath = join(rootDir, '.output', 'public', '__nuxt_content', collection, 'sql_dump.txt')
    if (existsSync(dumpPath)) {
      return readFileSync(dumpPath, 'utf8')
    }
  } catch (e) {
    // ignore
  }

  const data = await useStorage().getItem(`build:content:database.compressed.mjs`) || ''
  if (data) {
    const lineStart = `export const ${collection} = "`
    const content = String(data).split('\n').find(line => line.startsWith(lineStart))
    if (content) {
      return content
        .substring(lineStart.length, content.length - 1)
    }
  }

  return await import('#content/dump').then(m => m[collection])
})
