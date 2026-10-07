import { z } from '@hono/zod-openapi'

const Environment = z.object({
  DATABASE_URL: z.url().refine((v) => /^postgres(ql)?:/.test(v)),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGIN: z.url().default('http://localhost:5173'),
  ASSET_BASE_URL: z.string().default('/assets'),
  ELECTION_PRESENTATION_FILE: z.string().optional(),
  PHOTO_DIRECTORY: z.string().optional(),
})
export function readConfig(env = process.env) {
  const parsed = Environment.parse(env)
  const origin = new URL(parsed.CORS_ORIGIN)
  if (origin.origin !== parsed.CORS_ORIGIN) throw new Error('CORS_ORIGIN must be a URL origin')
  if (!/^\/(?!\/)/.test(parsed.ASSET_BASE_URL) && !/^https?:\/\//.test(parsed.ASSET_BASE_URL))
    throw new Error('ASSET_BASE_URL must be an absolute HTTP URL or an origin-relative path')
  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
    corsOrigin: parsed.CORS_ORIGIN,
    assetBaseUrl: parsed.ASSET_BASE_URL.replace(/\/$/, ''),
    presentationFile:
      parsed.ELECTION_PRESENTATION_FILE ??
      new URL('../config/election-presentation.json', import.meta.url),
    photoDirectory: parsed.PHOTO_DIRECTORY ?? new URL('../public', import.meta.url).pathname,
  }
}
export type Config = ReturnType<typeof readConfig>
