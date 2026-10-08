import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createPool } from '../src/db/index.js'
import {
  DEFAULT_NETWORK,
  InterruptedError,
  TSE_RATE_LIMIT,
  abortOnSignals,
} from '../src/modules/elections/ingestion/fetch.js'
import { downloadPhotos } from '../src/modules/elections/ingestion/photos.js'
const { values } = parseArgs({
  options: {
    publication: { type: 'string' },
    contest: { type: 'string' },
    limit: { type: 'string' },
    offline: { type: 'boolean' },
    refresh: { type: 'boolean' },
    archive: {
      type: 'string',
      default: process.env.ELECTION_ARCHIVE_DIR ?? '../../.data/elections',
    },
    concurrency: { type: 'string', default: String(DEFAULT_NETWORK.concurrency) },
    rate: { type: 'string', default: String(DEFAULT_NETWORK.rate) },
    'progress-interval': { type: 'string', default: '30' },
  },
})
if (
  values.limit !== undefined &&
  (!/^\d+$/.test(values.limit) || Number(values.limit) < 1 || Number(values.limit) > 100_000)
)
  throw new Error('--limit must be 1..100000')
const number = (key: 'concurrency' | 'rate' | 'progress-interval', max: number) => {
  const value = Number(values[key])
  if (!/^\d+(\.\d+)?$/.test(values[key]!) || !(value > 0) || value > max)
    throw new Error(`--${key} must be a number above 0 and at most ${max}`)
  return value
}
const concurrency = number('concurrency', 64)
if (!Number.isInteger(concurrency)) throw new Error('--concurrency must be an integer')
const rate = number('rate', TSE_RATE_LIMIT)
const progressIntervalMs = number('progress-interval', 86_400) * 1000
const pool = createPool()
const interrupt = abortOnSignals('Stopping after the photos in progress; repeat to force exit')
try {
  const summary = await downloadPhotos(pool, {
    publicationId: values.publication,
    contestId: values.contest,
    limit: values.limit === undefined ? undefined : Number(values.limit),
    archiveDir: values.archive!,
    photoDirectory:
      process.env.PHOTO_DIRECTORY ?? fileURLToPath(new URL('../public', import.meta.url)),
    offline: values.offline,
    refresh: values.refresh,
    network: { concurrency, rate },
    progressIntervalMs,
    signal: interrupt.signal,
  })
  console.log(JSON.stringify(summary, null, 2))
  if (summary.failed) process.exitCode = 1
  if ('interrupted' in summary) {
    const reason = interrupt.signal.reason
    process.exitCode = reason instanceof InterruptedError && reason.signal === 'SIGTERM' ? 143 : 130
  }
} finally {
  interrupt.dispose()
  await pool.end()
}
