import { serveStatic } from '@hono/node-server/serve-static'
import { OpenAPIHono, z } from '@hono/zod-openapi'
import { compress } from 'hono/compress'
import { cors } from 'hono/cors'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { Config } from './config.js'
import { ApiError, classifyError, type HttpEnvironment } from './http/errors.js'
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
const pinnedPublication = z.uuid()

export async function createApp(pool: pg.Pool, config: Config) {
  const present = await loadPresentation(
    config.presentationFile,
    config.assetBaseUrl,
    config.photoDirectory,
  )
  const app = new OpenAPIHono<HttpEnvironment>()
  app.use('*', compress())
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
  // Published data is immutable, but responses also carry editorial presentation (color, photo,
  // display name) that can change without a new publication, so pinned reads are cached for an
  // hour. Without publicationId the active publication may move, so no cache header is sent.
  app.use('*', async (c, next) => {
    await next()
    if (
      c.res.status === 200 &&
      /^\/(elections\/|contests\/|sources\/)/.test(c.req.path) &&
      pinnedPublication.safeParse(c.req.query('publicationId')).success
    )
      c.res.headers.set('Cache-Control', 'public, max-age=3600')
  })
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
    const { status, code, message } = classifyError(error)
    if (!(error instanceof ApiError))
      console.error({
        requestId: c.get('requestId'),
        code: 'code' in error ? String(error.code) : undefined,
        message: error.message,
      })
    return c.json({ error: { code, message, requestId: c.get('requestId') } }, status)
  })
  return app
}
