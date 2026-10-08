import type { ContentfulStatusCode } from 'hono/utils/http-status'
export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}
export type HttpEnvironment = { Variables: { requestId: string } }

/** Public status, code and message for an error; internal details never leave the server. */
export function classifyError(error: unknown): {
  status: ContentfulStatusCode
  code: string
  message: string
} {
  if (error instanceof ApiError)
    return { status: error.status, code: error.code, message: error.message }
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
  const message = error instanceof Error ? error.message : ''
  // statement_timeout: the request asked for more work than one read may take.
  if (code === '57014')
    return {
      status: 503,
      code: 'QUERY_TIMEOUT',
      message: 'Query exceeded the time limit; narrow the scope or page',
    }
  // Connection, resource and operator-intervention classes, socket errors, and pg-pool's
  // connection timeout, which carries no code.
  if (
    (code &&
      (/^(08|53|57)/.test(code) ||
        ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(code))) ||
    message === 'timeout exceeded when trying to connect'
  )
    return { status: 503, code: 'DATABASE_UNAVAILABLE', message: 'Database is unavailable' }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Unexpected server error' }
}
