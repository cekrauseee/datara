import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type pg from 'pg'
import type { HttpEnvironment } from '../../http/errors.js'
import * as schema from './contracts.js'
import type { Presentation } from './presentation.js'
import * as query from './queries.js'

export function electionRoutes(pool: pg.Pool, present: Presentation) {
  const app = new OpenAPIHono<HttpEnvironment>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json(
          {
            error: {
              code: 'INVALID_PARAMETERS',
              message: 'Invalid request parameters',
              requestId: c.get('requestId'),
              details: result.error.issues.map((i) => ({
                path: i.path.join('.'),
                message: i.message,
              })),
            },
          },
          400,
        )
    },
  })
  const editionPath = z.object({ electionId: schema.Id })
  const contestPath = z.object({ contestId: schema.Id })
  app.openapi(
    createRoute({
      method: 'get',
      path: '/elections',
      summary: 'List available electoral editions',
      request: { query: schema.EditionQuery },
      responses: {
        200: {
          description: 'Available editions and active data publication',
          content: { 'application/json': { schema: schema.EditionsResponse } },
        },
        ...schema.errors,
      },
    }),
    async (c) =>
      c.json(
        schema.EditionsResponse.parse(
          await query.read(pool, (client) => query.listElections(client, c.req.valid('query'))),
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/elections/{electionId}',
      summary: 'Read an edition and its publication',
      request: { params: editionPath, query: schema.PublicationQuery },
      responses: {
        200: {
          description: 'Edition metadata',
          content: { 'application/json': { schema: schema.Edition } },
        },
        ...schema.errors,
      },
    }),
    async (c) =>
      c.json(
        schema.Edition.parse(
          await query.read(pool, (client) =>
            query.edition(
              client,
              c.req.valid('param').electionId,
              c.req.valid('query').publicationId,
            ),
          ),
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/elections/{electionId}/contests',
      summary: 'List official contests and seats',
      request: { params: editionPath, query: schema.PublicationQuery },
      responses: {
        200: {
          description: 'Contests within publication',
          content: { 'application/json': { schema: schema.ContestsResponse } },
        },
        ...schema.errors,
      },
    }),
    async (c) =>
      c.json(
        schema.ContestsResponse.parse(
          await query.read(pool, async (client) =>
            query.contests(
              (
                await query.electionContext(
                  client,
                  c.req.valid('param').electionId,
                  c.req.valid('query').publicationId,
                )
              ).context,
            ),
          ),
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/elections/{electionId}/areas',
      summary: 'Search and navigate electoral areas',
      request: { params: editionPath, query: schema.AreaQuery },
      responses: {
        200: {
          description: 'Paginated electoral catalogue',
          content: { 'application/json': { schema: schema.AreasResponse } },
        },
        ...schema.errors,
      },
    }),
    async (c) =>
      c.json(
        schema.AreasResponse.parse(
          await query.read(pool, async (client) =>
            query.areas(
              (
                await query.electionContext(
                  client,
                  c.req.valid('param').electionId,
                  c.req.valid('query').publicationId,
                )
              ).context,
              c.req.valid('query'),
            ),
          ),
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/contests/{contestId}/candidates',
      summary: 'List candidacies with resolved local presentation',
      request: { params: contestPath, query: schema.CandidateQuery },
      responses: {
        200: {
          description:
            'Paginated candidacies; official status applies to the official contest scope',
          content: { 'application/json': { schema: schema.CandidatesResponse } },
        },
        ...schema.errors,
      },
    }),
    async (c) =>
      c.json(
        schema.CandidatesResponse.parse(
          await query.read(pool, async (client) =>
            query.candidates(
              await query.contestContext(
                client,
                c.req.valid('param').contestId,
                c.req.valid('query').publicationId,
              ),
              c.req.valid('query'),
              present,
            ),
          ),
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/contests/{contestId}/results',
      summary: 'Read result totals, participation and votes in one area',
      request: { params: contestPath, query: schema.ResultQuery },
      responses: {
        200: {
          description:
            'BU or official totalization; aggregated sections share their principal result, not isolated votes',
          content: { 'application/json': { schema: schema.ResultsResponse } },
        },
        ...schema.errors,
      },
    }),
    async (c) =>
      c.json(
        schema.ResultsResponse.parse(
          await query.read(pool, async (client) => {
            const ctx = await query.contestContext(
              client,
              c.req.valid('param').contestId,
              c.req.valid('query').publicationId,
            )
            return query.results(
              ctx,
              c.req.valid('query').areaId ?? ctx.contest.scope_area_id,
              c.req.valid('query'),
              present,
            )
          }),
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/contests/{contestId}/distribution',
      summary: 'Read candidate support and contribution across areas',
      request: { params: contestPath, query: schema.DistributionQuery },
      responses: {
        200: {
          description:
            'Paginated territorial distribution; contribution requires the same source basis',
          content: { 'application/json': { schema: schema.DistributionResponse } },
        },
        ...schema.errors,
      },
    }),
    async (c) =>
      c.json(
        schema.DistributionResponse.parse(
          await query.read(pool, async (client) =>
            query.distribution(
              await query.contestContext(
                client,
                c.req.valid('param').contestId,
                c.req.valid('query').publicationId,
              ),
              c.req.valid('query'),
            ),
          ),
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/contests/{contestId}/map',
      summary: 'Read compact values keyed by existing map feature IDs',
      request: { params: contestPath, query: schema.MapQuery },
      responses: {
        200: {
          description:
            'State or municipality values without geometry; missing geometry and results are counted',
          content: { 'application/json': { schema: schema.MapResponse } },
        },
        ...schema.errors,
      },
    }),
    async (c) =>
      c.json(
        schema.MapResponse.parse(
          await query.read(pool, async (client) =>
            query.map(
              await query.contestContext(
                client,
                c.req.valid('param').contestId,
                c.req.valid('query').publicationId,
              ),
              c.req.valid('query'),
            ),
          ),
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/sources/{sourceId}',
      summary: 'Read public provenance without local archive paths',
      request: { params: z.object({ sourceId: z.uuid() }), query: schema.PublicationQuery },
      responses: {
        200: {
          description: 'Official URL, hash and collection/generation times',
          content: { 'application/json': { schema: schema.SourceResponse } },
        },
        ...schema.errors,
      },
    }),
    async (c) =>
      c.json(
        schema.SourceResponse.parse(
          await query.read(pool, (client) =>
            query.source(client, c.req.valid('param').sourceId, c.req.valid('query').publicationId),
          ),
        ),
        200,
      ),
  )
  return app
}
