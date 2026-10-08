import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import pg from 'pg'
import { createApp, openapiConfig } from '../src/app.js'
import { readConfig } from '../src/config.js'

const destination = process.argv[2] ?? 'dist/openapi.json'
const output = resolve(destination)
const pool = new pg.Pool()
try {
  const app = await createApp(pool, readConfig({ DATABASE_URL: 'postgresql://localhost/datara' }))
  const document = app.getOpenAPI31Document(openapiConfig)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`)
  console.log(`OpenAPI: ${Object.keys(document.paths ?? {}).length} routes (${destination})`)
} finally {
  await pool.end()
}
