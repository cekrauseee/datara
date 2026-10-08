import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { readConfig } from './config.js'
import { createPool } from './db/index.js'

const config = readConfig()
const pool = createPool(config.databaseUrl)
const app = await createApp(pool, config)
const server = serve({ fetch: app.fetch, port: config.port })
async function stop() {
  server.close()
  await pool.end()
}
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
