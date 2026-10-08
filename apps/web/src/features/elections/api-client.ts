import type { ApiErrorBody } from './api-types'

// Absolute API origin, without a trailing slash. `pnpm dev` injects VITE_API_URL from the API PORT.
export const API_URL = new URL(import.meta.env.VITE_API_URL ?? 'http://localhost:3000')
const base = API_URL.href.replace(/\/+$/, '')

export type ApiParams = Record<string, string | number | boolean | null | undefined>
export type RequestOptions = { signal?: AbortSignal; timeout?: number }

// Client-side codes complete the API's own `error.code` values.
export type ClientErrorCode =
  'NETWORK_ERROR' | 'TIMEOUT' | 'INVALID_RESPONSE' | 'SUPERSEDED' | 'UNKNOWN'

export class ApiClientError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string | null

  constructor(input: {
    status: number
    code: string
    message: string
    requestId?: string | null
    cause?: unknown
  }) {
    super(input.message, { cause: input.cause })
    this.name = 'ApiClientError'
    this.status = input.status
    this.code = input.code
    this.requestId = input.requestId ?? null
  }
}

export function toApiClientError(error: unknown): ApiClientError {
  if (error instanceof ApiClientError) return error
  return new ApiClientError({
    status: 0,
    code: 'UNKNOWN',
    message: error instanceof Error ? error.message : 'Falha desconhecida ao consultar a API.',
    cause: error,
  })
}

export function isApiError(
  error: unknown,
  status?: number,
  code?: string,
): error is ApiClientError {
  return (
    error instanceof ApiClientError &&
    (status === undefined || error.status === status) &&
    (code === undefined || error.code === code)
  )
}

// Full request URL; it is also the cache key, so parameters keep their insertion order.
export function apiURL(path: string, params: ApiParams = {}): string {
  const url = new URL(`${base}${path}`)
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== null && value !== '')
      url.searchParams.set(key, String(value))
  return url.href
}

function isErrorBody(body: unknown): body is ApiErrorBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'object' &&
    body.error !== null &&
    'code' in body.error
  )
}

// `globalThis.fetch` is read at call time so browser checks can intercept it.
export async function apiRequest<T>(
  url: string,
  { signal, timeout = 20_000 }: RequestOptions = {},
): Promise<T> {
  const signals = [AbortSignal.timeout(timeout)]
  if (signal) signals.push(signal)
  let response: Response
  try {
    response = await globalThis.fetch(url, {
      signal: AbortSignal.any(signals),
      headers: { accept: 'application/json' },
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError')
      throw new ApiClientError({
        status: 0,
        code: 'TIMEOUT',
        message: 'A API de resultados demorou demais para responder.',
        cause: error,
      })
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiClientError({
      status: 0,
      code: 'NETWORK_ERROR',
      message: 'Não foi possível contatar a API de resultados.',
      cause: error,
    })
  }
  const requestId = response.headers.get('x-request-id')
  let body: unknown = null
  try {
    body = await response.json()
  } catch (error) {
    if (response.ok)
      throw new ApiClientError({
        status: response.status,
        code: 'INVALID_RESPONSE',
        message: 'A API de resultados devolveu uma resposta inválida.',
        requestId,
        cause: error,
      })
  }
  if (!response.ok) {
    const detail = isErrorBody(body) ? body.error : null
    throw new ApiClientError({
      status: response.status,
      code: detail?.code ?? `HTTP_${response.status}`,
      message: detail?.message ?? `A API de resultados respondeu com o status ${response.status}.`,
      requestId: detail?.requestId ?? requestId,
    })
  }
  return body as T
}

export function apiFetch<T>(path: string, params: ApiParams = {}, options: RequestOptions = {}) {
  return apiRequest<T>(apiURL(path, params), options)
}

// Relative photo URLs resolve against the API origin, which serves ASSET_BASE_URL.
export function photoURL(photoUrl: string): string {
  return new URL(photoUrl, API_URL).href
}
