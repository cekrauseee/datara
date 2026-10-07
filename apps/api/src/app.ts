import { serveStatic } from '@hono/node-server/serve-static'
import { OpenAPIHono } from '@hono/zod-openapi'
import { cors } from 'hono/cors'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { Config } from './config.js'
import { ApiError, type HttpEnvironment } from './http/errors.js'
import { loadPresentation } from './modules/elections/presentation.js'
import { electionRoutes } from './modules/elections/routes.js'

export const openapiConfig = {
  openapi: '3.1.0',
  info: {
    title: 'Datara election API',
    version: '0.1.0',
    description:
      'Queries immutable published electoral data. publicationId is a data snapshot, not an API version. Counts and percentages preserve BU versus official judicial-totalization semantics.',
  },
}

export async function createApp(pool: pg.Pool, config: Config) {
  const present = await loadPresentation(
    config.presentationFile,
    config.assetBaseUrl,
    config.photoDirectory,
  )
  const app = new OpenAPIHono<HttpEnvironment>()
  app.use('*', async (c, next) => {
    const requestId = randomUUID()
    c.set('requestId', requestId)
    c.header('X-Request-Id', requestId)
    await next()
  })
  app.use(
    '*',
    cors({
      origin: config.corsOrigin,
      allowMethods: ['GET', 'OPTIONS'],
      exposeHeaders: ['X-Request-Id'],
    }),
  )
  app.get('/', (c) => c.json({ message: 'datara' }))
  app.get(
    '/assets/*',
    serveStatic({
      root: config.photoDirectory,
      rewriteRequestPath: (path) => path.replace(/^\/assets\//, ''),
    }),
  )
  app.route('/', electionRoutes(pool, present))
  app.doc31('/openapi.json', openapiConfig)
  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'ROUTE_NOT_FOUND',
          message: 'Route not found',
          requestId: c.get('requestId'),
        },
      },
      404,
    ),
  )
  app.onError((error, c) => {
    if (error instanceof ApiError)
      return c.json(
        { error: { code: error.code, message: error.message, requestId: c.get('requestId') } },
        error.status,
      )
    const code = 'code' in error ? String(error.code) : undefined
    const databaseError =
      code &&
      (/^(08|53|57)/.test(code) ||
        ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(code))
    console.error({ requestId: c.get('requestId'), code, message: error.message })
    return c.json(
      {
        error: {
          code: databaseError ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR',
          message: databaseError ? 'Database is unavailable' : 'Unexpected server error',
          requestId: c.get('requestId'),
        },
      },
      databaseError ? 503 : 500,
    )
  })
  return app
}
