import { generateFilesOnly } from 'fumadocs-openapi'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { openapi } from '../src/lib/openapi.js'

const files = await generateFilesOnly({
  input: openapi,
  per: 'operation',
  name: ({ item, schemaId }) =>
    `api/reference/${('path' in item ? item.path : item.name).replaceAll(/[{}]/g, '').replace(/^\//, '').replaceAll('/', '-')}.${schemaId === 'datara-pt' ? 'pt' : 'en'}`,
})

await rm('.generated/reference', { recursive: true, force: true })
for (const file of files) {
  const destination = join('.generated/reference', file.path)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, file.content)
}
console.log(`API reference: ${files.length} pages (English / Portuguese)`)
