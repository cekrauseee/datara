import { parseArgs } from 'node:util'
import { createPool, migrate } from '../src/db/index.js'
import {
  DEFAULT_NETWORK,
  InterruptedError,
  TSE_RATE_LIMIT,
  abortOnSignals,
} from '../src/modules/elections/ingestion/fetch.js'
import { importElection, publishPublication } from '../src/modules/elections/ingestion/import.js'

const { values } = parseArgs({
  options: {
    scope: { type: 'string', default: 'pilot' },
    resume: { type: 'string' },
    archive: {
      type: 'string',
      default: process.env.ELECTION_ARCHIVE_DIR ?? '../../.data/elections',
    },
    offline: { type: 'boolean' },
    refresh: { type: 'boolean' },
    'no-publish': { type: 'boolean' },
    publish: { type: 'string' },
    migrate: { type: 'boolean' },
    'pilot-ufs': { type: 'string', default: 'ac,df,pe,zz' },
    municipalities: { type: 'string', default: '1' },
    sections: { type: 'string', default: '2' },
    'stop-after': { type: 'string' },
    estimate: { type: 'boolean' },
    concurrency: { type: 'string', default: String(DEFAULT_NETWORK.concurrency) },
    rate: { type: 'string', default: String(DEFAULT_NETWORK.rate) },
    timeout: { type: 'string', default: String(DEFAULT_NETWORK.timeoutMs / 1000) },
    'progress-interval': { type: 'string', default: '30' },
    'keep-going': { type: 'boolean' },
    'no-keep-going': { type: 'boolean' },
  },
})
if (!['pilot', 'national'].includes(values.scope!))
  throw new Error('--scope must be pilot or national')
for (const key of ['municipalities', 'sections', 'stop-after'] as const)
  if (values[key] !== undefined && (!/^\d+$/.test(values[key]!) || Number(values[key]) > 1_000_000))
    throw new Error(`Invalid --${key}`)
if (!/^[a-z]{2}(,[a-z]{2})*$/.test(values['pilot-ufs']!)) throw new Error('Invalid --pilot-ufs')
const number = (key: 'concurrency' | 'rate' | 'timeout' | 'progress-interval', max: number) => {
  const value = Number(values[key])
  if (!/^\d+(\.\d+)?$/.test(values[key]!) || !(value > 0) || value > max)
    throw new Error(`--${key} must be a number above 0 and at most ${max}`)
  return value
}
const concurrency = number('concurrency', 64)
if (!Number.isInteger(concurrency)) throw new Error('--concurrency must be an integer')
const rate = number('rate', TSE_RATE_LIMIT)
const timeoutMs = number('timeout', 600) * 1000
const progressIntervalMs = number('progress-interval', 86_400) * 1000
if (values['keep-going'] && values['no-keep-going'])
  throw new Error('Choose either --keep-going or --no-keep-going')
const pool = createPool()
const interrupt = abortOnSignals()
try {
  await migrate(pool)
  if (values.publish) {
    const client = await pool.connect()
    try {
      await publishPublication(client, values.publish)
    } finally {
      client.release()
    }
    console.log(`Published ${values.publish}`)
  } else if (!values.migrate) {
    const result = await importElection(pool, {
      scope: values.scope as 'pilot' | 'national',
      publicationId: values.resume,
      archiveDir: values.archive!,
      offline: values.offline,
      refresh: values.refresh,
      publish: !values['no-publish'],
      municipalitiesPerUf: Number(values.municipalities),
      sectionsPerUf: Number(values.sections),
      pilotUfs: values['pilot-ufs']!.split(','),
      stopAfter: values['stop-after'] === undefined ? undefined : Number(values['stop-after']),
      estimate: values.estimate,
      keepGoing: values['keep-going'] ? true : values['no-keep-going'] ? false : undefined,
      progressIntervalMs,
      network: { concurrency, rate, timeoutMs },
      signal: interrupt.signal,
    })
    console.log(JSON.stringify(result, null, 2))
    if (result.status === 'paused') {
      if (result.reason === 'interrupted') {
        const reason = interrupt.signal.reason
        process.exitCode =
          reason instanceof InterruptedError && reason.signal === 'SIGTERM' ? 143 : 130
      } else if (result.reason === 'source-unavailable' || result.reason === 'unit-failures')
        process.exitCode = 1
      console.error(
        `Paused (${result.reason}). Resume with --resume ${result.publicationId} and the same scope, limits and archive.`,
      )
    }
  }
} finally {
  interrupt.dispose()
  await pool.end()
}
