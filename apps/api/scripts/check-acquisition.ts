import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type pg from 'pg'
import {
  FetchError,
  FetchHaltedError,
  Fetcher,
  SourceMissingError,
  TSE_RATE_LIMIT,
  sleep,
} from '../src/modules/elections/ingestion/fetch.js'
import {
  Archive,
  BASE,
  hash,
  removeStaleTemporaryFiles,
} from '../src/modules/elections/ingestion/source.js'

// Acquisition policy against a scripted in-process server: no network, no database.
type Reply = number | Response | ((signal: AbortSignal) => Promise<Response>)
function server(script: (url: string, call: number) => Reply) {
  const calls: { url: string; at: number }[] = []
  let active = 0
  let peak = 0
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const call = calls.filter((c) => c.url === url).length
    calls.push({ url, at: performance.now() })
    active++
    peak = Math.max(peak, active)
    try {
      const reply = script(url, call)
      if (typeof reply === 'number')
        return new Response(reply === 200 ? `ok ${url}` : null, { status: reply })
      if (reply instanceof Response) return reply
      return await reply(init!.signal!)
    } finally {
      active--
    }
  }) as typeof fetch
  return { fetch: fake, calls, peak: () => peak }
}
const quiet = () => {}
const url = (name: string) => `${BASE}/check/${name}`
const delayed = (ms: number, response: () => Response) => (signal: AbortSignal) =>
  sleep(ms, [signal]).then(response)

// Rate ceiling: no more than `rate` request starts in any one-second window.
{
  assert.throws(() => new Fetcher({ rate: TSE_RATE_LIMIT + 1 }), /at most 100/)
  const tse = server(() => 200)
  const fetcher = new Fetcher({ rate: 40, concurrency: 16, fetch: tse.fetch, log: quiet })
  const started = performance.now()
  await Promise.all(Array.from({ length: 60 }, (_, i) => fetcher.get(url(`rate-${i}`))))
  const starts = tse.calls.map((c) => c.at).sort((a, b) => a - b)
  for (let i = 0; i + 40 < starts.length; i++)
    assert.ok(starts[i + 40]! - starts[i]! >= 995, `more than 40 starts within one second at ${i}`)
  assert.ok(performance.now() - started >= 59 * 25 - 5)
}

// Concurrency: in-flight requests never exceed the limit.
{
  const tse = server(() => delayed(40, () => new Response('ok')))
  const fetcher = new Fetcher({ concurrency: 3, rate: 100, fetch: tse.fetch, log: quiet })
  await Promise.all(Array.from({ length: 12 }, (_, i) => fetcher.get(url(`slot-${i}`))))
  assert.equal(tse.peak(), 3)
}

// 503 then success, with exponential backoff and jitter of at most 25%.
{
  const tse = server((_, call) => (call < 2 ? 503 : 200))
  const fetcher = new Fetcher({ retryDelayMs: 20, fetch: tse.fetch, rate: 100, log: quiet })
  const result = await fetcher.get(url('flaky'))
  assert.equal(result.ok, true)
  assert.equal(tse.calls.length, 3)
  assert.equal(fetcher.stats.retries, 2)
  assert.ok(tse.calls[1]!.at - tse.calls[0]!.at >= 15)
  assert.ok(tse.calls[2]!.at - tse.calls[1]!.at >= 30)
}

// Retry-After is honored when longer than the backoff.
{
  const tse = server((_, call) =>
    call === 0 ? new Response(null, { status: 503, headers: { 'retry-after': '1' } }) : 200,
  )
  const fetcher = new Fetcher({ retryDelayMs: 10, fetch: tse.fetch, rate: 100, log: quiet })
  await fetcher.get(url('retry-after'))
  assert.ok(tse.calls[1]!.at - tse.calls[0]!.at >= 995)
}

// 429 and 403 put every request on hold for the cool-down before the next attempt.
for (const status of [429, 403]) {
  let blocked!: () => void
  const block = new Promise<void>((resolve) => (blocked = resolve))
  const tse = server((name, call) => {
    if (name === url('blocked') && call === 0) {
      setImmediate(blocked)
      return status
    }
    return 200
  })
  const events: Record<string, unknown>[] = []
  const fetcher = new Fetcher({
    coolDownMs: 300,
    concurrency: 4,
    rate: 100,
    fetch: tse.fetch,
    log: (event) => events.push(event),
  })
  const first = fetcher.get(url('blocked'))
  await block
  const blockedAt = performance.now()
  const second = fetcher.get(url('queued'))
  assert.equal((await first).ok, true)
  assert.equal((await second).ok, true)
  const after = tse.calls.filter((c) => c.at >= blockedAt)
  assert.equal(after.length, 2)
  for (const call of after) assert.ok(call.at - blockedAt >= 290, `${status} cool-down ignored`)
  assert.equal(fetcher.stats.coolDowns, 1)
  assert.equal(events[0]?.event, 'cool-down')
}

// 404/410 are never retried; three consecutive ones halt every pending and future request.
{
  const tse = server((name) =>
    name.includes('slow')
      ? (signal) => sleep(10_000, [signal]).then(() => new Response('late'))
      : 404,
  )
  const fetcher = new Fetcher({ fetch: tse.fetch, rate: 100, log: quiet })
  const slow = fetcher.get(url('slow'))
  await assert.rejects(fetcher.get(url('missing-1')), SourceMissingError)
  assert.equal(tse.calls.filter((c) => c.url === url('missing-1')).length, 1)
  assert.equal(fetcher.stats.retries, 0)
  await assert.rejects(fetcher.get(url('missing-2')), SourceMissingError)
  await assert.rejects(fetcher.get(url('missing-3')), SourceMissingError)
  assert.equal(fetcher.halted, true)
  await assert.rejects(slow, FetchHaltedError)
  const before = tse.calls.length
  await assert.rejects(fetcher.get(url('after-halt')), FetchHaltedError)
  assert.equal(tse.calls.length, before)
}
// A missing optional source (photos) is a result, not an error.
{
  const tse = server(() => 410)
  const fetcher = new Fetcher({ fetch: tse.fetch, missingLimit: 25, rate: 100, log: quiet })
  assert.deepEqual(await fetcher.get(url('photo'), { allowMissing: true }), {
    ok: false,
    status: 410,
  })
}

// A timeout is retried; other client errors and oversized bodies are not.
{
  const tse = server((name, call) =>
    name.includes('hang') && call === 0
      ? (signal) =>
          new Promise<Response>((_, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          )
      : name.includes('bad')
        ? 400
        : name.includes('large')
          ? new Response('x'.repeat(2048))
          : 200,
  )
  const fetcher = new Fetcher({
    timeoutMs: 50,
    retryDelayMs: 10,
    maxBytes: 1024,
    fetch: tse.fetch,
    rate: 100,
    log: quiet,
  })
  assert.equal((await fetcher.get(url('hang'))).ok, true)
  assert.equal(fetcher.stats.timeouts, 1)
  assert.equal(fetcher.stats.retries, 1)
  await assert.rejects(fetcher.get(url('bad')), (error: FetchError) => error.status === 400)
  await assert.rejects(fetcher.get(url('large')), /exceeds 1024 bytes/)
  assert.equal(tse.calls.filter((c) => /bad|large/.test(c.url)).length, 2)
}

// Aborting a request waiting for its rate slot neither sends it nor blocks the next one.
{
  const tse = server(() => 200)
  const fetcher = new Fetcher({ rate: 2, fetch: tse.fetch, log: quiet })
  await fetcher.get(url('first'))
  const controller = new AbortController()
  const waiting = fetcher.get(url('aborted'), { signal: controller.signal })
  controller.abort(new Error('stop'))
  await assert.rejects(waiting, /stop/)
  await fetcher.get(url('next'))
  assert.deepEqual(
    tse.calls.map((c) => c.url),
    [url('first'), url('next')],
  )
}

// Archive prefetch writes complete bytes and references only; an abort leaves no temporary file.
const directory = await mkdtemp(join(tmpdir(), 'datara-acquisition-'))
try {
  const bulletin = Buffer.from('synthetic bulletin bytes')
  const auxUrl = `${BASE}/ele2026/arquivo-urna/3220/dados/ac/01066/0004/0077/p003220-ac-m01066-z0004-s0077-aux.json`
  const buUrl = `${BASE}/ele2026/arquivo-urna/3220/dados/ac/01066/0004/0077/abc123/o00001-bu.dat`
  const tse = server((name) => {
    if (name === auxUrl)
      return new Response(
        JSON.stringify({
          f: 'o',
          st: 'Totalizada',
          hashes: [
            { hash: 'abc123', st: 'Totalizado', arq: [{ nm: 'o00001-bu.dat', tp: 'bu' }] },
            { hash: 'def456', st: 'Excluído', arq: [{ nm: 'o00002-bu.dat', tp: 'bu' }] },
          ],
        }),
      )
    if (name === buUrl) return new Response(bulletin)
    // A body that trickles until the request is aborted, which errors it as fetch does.
    return (signal) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            async pull(controller) {
              try {
                await sleep(20, [signal])
                controller.enqueue(new TextEncoder().encode('partial'))
              } catch (error) {
                controller.error(error)
              }
            },
          }),
        ),
      )
  })
  const fetcher = new Fetcher({ fetch: tse.fetch, rate: 100, log: quiet })
  const archive = new Archive(undefined as unknown as pg.PoolClient, 'check', directory, {
    fetcher,
  })
  await archive.prefetch(auxUrl, 'EA18')
  assert.deepEqual(
    tse.calls.map((c) => c.url),
    [auxUrl, buUrl],
  )
  assert.ok((await readdir(join(directory, 'sha256'))).includes(hash(bulletin)))
  assert.equal((await readdir(join(directory, 'urls'))).length, 2)
  await archive.prefetch(auxUrl, 'EA18')
  assert.equal(tse.calls.length, 2, 'archived sources are not downloaded again')
  const controller = new AbortController()
  const slow = archive.prefetch(`${BASE}/check/trickle.json`, 'EA20', controller.signal)
  await sleep(70)
  controller.abort(new Error('interrupted'))
  await assert.rejects(slow, /interrupted/)
  const files = [
    ...(await readdir(join(directory, 'sha256'))),
    ...(await readdir(join(directory, 'urls'))),
  ]
  assert.equal(files.length, 4)
  assert.ok(files.every((file) => !file.endsWith('.tmp')))
  // Orphans of a killed process are removed at the next start, unless they may still be written.
  await mkdir(join(directory, 'photo-urls'), { recursive: true })
  const old = join(directory, 'sha256', 'orphan.11111111-1111-1111-1111-111111111111.tmp')
  const recent = join(directory, 'photo-urls', 'recent.22222222-2222-2222-2222-222222222222.tmp')
  await writeFile(old, 'x')
  await writeFile(recent, 'y')
  await utimes(old, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
  assert.equal(await removeStaleTemporaryFiles(directory), 1)
  assert.ok(!(await readdir(join(directory, 'sha256'))).some((file) => file.startsWith('orphan')))
  assert.ok(
    (await readdir(join(directory, 'photo-urls'))).some((file) => file.startsWith('recent')),
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
console.log(
  'Acquisition policy without network: rate ceiling, bounded concurrency, 5xx backoff, Retry-After, 429/403 global cool-down, 404 without retry and halt after three, timeout retry, size limit, abort without request, prefetch with bulletin selection, abort without temporary files, stale temporary cleanup',
)
