import { performance } from 'node:perf_hooks'

// TSE technical guidance: at most 100 requests per second per IP; exceeding it blocks the IP for
// 10 minutes, renewed while the excess continues, and repeated 404 responses may also block it.
export const TSE_RATE_LIMIT = 100
export const USER_AGENT = 'datara-elections/1.0 (+https://github.com/cekrauseee/datara)'

export type NetworkOptions = {
  /** Simultaneous HTTP requests, including body transfer. */
  concurrency?: number
  /** Process-wide request starts per second; never above the TSE limit. */
  rate?: number
  /** Per-attempt timeout covering headers and body. */
  timeoutMs?: number
  attempts?: number
  retryDelayMs?: number
  maxRetryDelayMs?: number
  /** Pause applied to every request after HTTP 429/403 (blocking responses). */
  coolDownMs?: number
  maxBytes?: number
  /** Consecutive 404/410 responses that halt the fetcher. */
  missingLimit?: number
  fetch?: typeof fetch
  log?: (event: Record<string, unknown>) => void
}
export const DEFAULT_NETWORK = {
  concurrency: 6,
  rate: 20,
  timeoutMs: 60_000,
  attempts: 6,
  retryDelayMs: 1_000,
  maxRetryDelayMs: 32_000,
  coolDownMs: 630_000,
  maxBytes: 64 * 1024 * 1024,
  missingLimit: 3,
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message)
  }
}
/** HTTP 404/410: never retried and never converted into an official absence. */
export class SourceMissingError extends FetchError {}
/** The fetcher stopped after consecutive missing responses; no further requests are sent. */
export class FetchHaltedError extends FetchError {}
export class InterruptedError extends Error {
  constructor(readonly signal: string) {
    super(`Interrupted by ${signal}`)
    this.name = 'AbortError'
  }
}

export type FetchResult =
  { ok: true; status: number; bytes: Buffer } | { ok: false; status: number }
type Attempt =
  | { status: number; bytes?: Buffer; retryAfterMs?: number }
  | { error: FetchError; retryAfterMs?: number }

export class Fetcher {
  readonly policy: typeof DEFAULT_NETWORK
  readonly stats = {
    requests: 0,
    responses: 0,
    bytes: 0,
    retries: 0,
    failures: 0,
    missing: 0,
    timeouts: 0,
    coolDowns: 0,
  }
  private readonly fetchImpl: typeof fetch
  private readonly log: (event: Record<string, unknown>) => void
  private readonly halt = new AbortController()
  private readonly interval: number
  private active = 0
  private readonly waiting: (() => void)[] = []
  private gate: Promise<void> = Promise.resolve()
  private lastStart = -Infinity
  private pausedUntil = 0
  private consecutiveMissing = 0

  constructor(options: NetworkOptions = {}) {
    const defined = Object.fromEntries(
      Object.entries(options).filter(
        ([key, value]) => value !== undefined && key in DEFAULT_NETWORK,
      ),
    )
    this.policy = { ...DEFAULT_NETWORK, ...defined }
    const { concurrency, rate, timeoutMs, attempts, missingLimit } = this.policy
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64)
      throw new Error('Concurrency must be an integer from 1 to 64')
    if (!(rate > 0) || rate > TSE_RATE_LIMIT)
      throw new Error(`Rate must be above 0 and at most ${TSE_RATE_LIMIT} requests per second`)
    if (!(timeoutMs > 0)) throw new Error('Timeout must be positive')
    if (!Number.isInteger(attempts) || attempts < 1) throw new Error('Attempts must be positive')
    if (!Number.isInteger(missingLimit) || missingLimit < 1)
      throw new Error('Missing limit must be positive')
    this.interval = 1000 / rate
    this.fetchImpl = options.fetch ?? fetch
    this.log = options.log ?? ((event) => console.log(JSON.stringify(event)))
  }
  get halted() {
    return this.halt.signal.aborted
  }

  /** Downloads one URL under the shared concurrency, rate, timeout and retry policy. */
  async get(
    url: string,
    options: { signal?: AbortSignal; allowMissing?: boolean } = {},
  ): Promise<FetchResult> {
    const signals = [options.signal, this.halt.signal]
    for (let attempt = 1; ; attempt++) {
      let outcome: Attempt
      throwIfAborted(signals)
      await this.acquire(signals)
      try {
        await this.slot(signals)
        throwIfAborted(signals)
        this.stats.requests++
        outcome = await this.attempt(url, signals)
      } finally {
        this.release()
      }
      if ('error' in outcome && !outcome.error.retryable) {
        this.stats.failures++
        throw outcome.error
      }
      if (!('error' in outcome)) {
        const { status } = outcome
        if (outcome.bytes) {
          this.consecutiveMissing = 0
          return { ok: true, status, bytes: outcome.bytes }
        }
        if (status === 404 || status === 410) {
          this.stats.missing++
          if (++this.consecutiveMissing >= this.policy.missingLimit && !this.halted) {
            this.log({ event: 'fetch-halted', reason: 'consecutive missing sources', url, status })
            this.halt.abort(
              new FetchHaltedError(
                `Acquisition halted after ${this.consecutiveMissing} consecutive missing sources (last HTTP ${status}: ${url})`,
                url,
                status,
              ),
            )
          }
          if (options.allowMissing) return { ok: false, status }
          throw new SourceMissingError(`TSE source not found (HTTP ${status}): ${url}`, url, status)
        }
        this.consecutiveMissing = 0
        if (status === 429 || status === 403) {
          // Retrying during a block renews it, so every queued request waits for the cool-down.
          const until =
            performance.now() + Math.max(this.policy.coolDownMs, outcome.retryAfterMs ?? 0)
          if (until > this.pausedUntil) {
            this.pausedUntil = until
            this.stats.coolDowns++
            this.log({
              event: 'cool-down',
              status,
              url,
              seconds: Math.round((until - performance.now()) / 1000),
            })
          }
        } else if (status < 500 && status !== 408) {
          this.stats.failures++
          throw new FetchError(`TSE request failed (HTTP ${status}): ${url}`, url, status)
        }
      }
      const status = 'error' in outcome ? outcome.error.status : outcome.status
      if (attempt >= this.policy.attempts) {
        this.stats.failures++
        const reason = 'error' in outcome ? outcome.error.message : `HTTP ${status}`
        throw new FetchError(
          `TSE request failed after ${attempt} attempts (${reason}): ${url}`,
          url,
          status,
        )
      }
      this.stats.retries++
      if (status === 429 || status === 403) continue
      const backoff = Math.min(
        this.policy.maxRetryDelayMs,
        this.policy.retryDelayMs * 2 ** (attempt - 1),
      )
      const wait = Math.max(backoff * (0.75 + Math.random() * 0.5), outcome.retryAfterMs ?? 0)
      await sleep(
        Math.min(wait, Math.max(this.policy.coolDownMs, this.policy.maxRetryDelayMs)),
        signals,
      )
    }
  }

  private async attempt(url: string, signals: (AbortSignal | undefined)[]): Promise<Attempt> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`Timed out after ${this.policy.timeoutMs} ms`))
    }, this.policy.timeoutMs)
    const unlink = link(signals, controller)
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT },
      })
      this.stats.responses++
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        return { status: response.status, retryAfterMs: retryAfter(response.headers) }
      }
      const bytes = await readBody(response, this.policy.maxBytes, url, controller.signal)
      this.stats.bytes += bytes.length
      return { status: response.status, bytes }
    } catch (error) {
      throwIfAborted(signals)
      if (error instanceof FetchError) return { error }
      if (timedOut) {
        this.stats.timeouts++
        const message = `timed out after ${this.policy.timeoutMs} ms`
        return { error: new FetchError(message, url, undefined, true) }
      }
      const code = (error as { cause?: { code?: string } }).cause?.code
      const message = error instanceof Error ? error.message : String(error)
      const detail = `network error: ${code ? `${message} (${code})` : message}`
      return { error: new FetchError(detail, url, undefined, true) }
    } finally {
      clearTimeout(timer)
      unlink()
    }
  }

  private async acquire(signals: (AbortSignal | undefined)[]) {
    if (this.active < this.policy.concurrency) {
      this.active++
      return
    }
    let entry!: () => void
    const queued = new Promise<void>((resolve) => (entry = resolve))
    this.waiting.push(entry)
    try {
      await untilAborted(queued, signals)
    } catch (error) {
      const index = this.waiting.indexOf(entry)
      if (index >= 0) this.waiting.splice(index, 1)
      // The slot may have been handed over just before the abort; give it back.
      else this.release()
      throw error
    }
  }
  private release() {
    const next = this.waiting.shift()
    if (next) next()
    else this.active--
  }
  // Request starts are serialized and spaced by 1/rate seconds, and wait out any cool-down.
  private async slot(signals: (AbortSignal | undefined)[]) {
    const previous = this.gate
    let done!: () => void
    const mine = new Promise<void>((resolve) => (done = resolve))
    this.gate = previous.then(() => mine)
    try {
      await untilAborted(previous, signals)
      for (;;) {
        const wait = Math.max(this.lastStart + this.interval, this.pausedUntil) - performance.now()
        if (wait <= 0) break
        await sleep(Math.max(1, Math.ceil(wait)), signals)
      }
      this.lastStart = performance.now()
    } finally {
      done()
    }
  }
}

async function readBody(response: Response, maxBytes: number, url: string, signal: AbortSignal) {
  const tooLarge = () =>
    new FetchError(`Source exceeds ${maxBytes} bytes: ${url}`, url, response.status)
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw tooLarge()
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (signal.aborted) {
      await reader.cancel().catch(() => {})
      throw signal.reason
    }
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
  }
  return Buffer.concat(chunks, total)
}
function retryAfter(headers: Headers) {
  const value = headers.get('retry-after')
  if (!value) return undefined
  if (/^\d+$/.test(value)) return Number(value) * 1000
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}
function throwIfAborted(signals: (AbortSignal | undefined)[]) {
  for (const signal of signals) signal?.throwIfAborted()
}
/** Propagates any of the signals to the controller; returns a function removing the listeners. */
function link(signals: (AbortSignal | undefined)[], controller: AbortController) {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  const onAbort = (event: Event) => controller.abort((event.target as AbortSignal).reason)
  for (const signal of active) signal.addEventListener('abort', onAbort, { once: true })
  return () => {
    for (const signal of active) signal.removeEventListener('abort', onAbort)
  }
}
/** Resolves with the promise, or rejects with the reason of the first aborted signal. */
export async function untilAborted<T>(
  promise: Promise<T>,
  signals: (AbortSignal | undefined)[],
): Promise<T> {
  throwIfAborted(signals)
  const controller = new AbortController()
  const unlink = link(signals, controller)
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
          once: true,
        }),
      ),
    ])
  } finally {
    unlink()
  }
}
export function sleep(ms: number, signals: (AbortSignal | undefined)[] = []) {
  let timer: NodeJS.Timeout | undefined
  return untilAborted(
    new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))),
    signals,
  ).finally(() => clearTimeout(timer))
}

/** First SIGINT/SIGTERM aborts the returned signal for a graceful pause; a second one exits. */
export function abortOnSignals(message = 'Pausing after the current unit; repeat to force exit') {
  const controller = new AbortController()
  const handler = (signal: NodeJS.Signals) => {
    if (controller.signal.aborted) {
      console.error(`Forced exit on second ${signal}`)
      process.exit(signal === 'SIGINT' ? 130 : 143)
    }
    console.error(`${signal} received. ${message}`)
    controller.abort(new InterruptedError(signal))
  }
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
  return {
    signal: controller.signal,
    dispose() {
      process.off('SIGINT', handler)
      process.off('SIGTERM', handler)
    },
  }
}
