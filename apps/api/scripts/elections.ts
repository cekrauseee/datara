import { parseArgs } from 'node:util'
import { createPool, migrate } from '../src/db/index.js'
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
  },
})
if (!['pilot', 'national'].includes(values.scope!))
  throw new Error('--scope must be pilot or national')
for (const key of ['municipalities', 'sections', 'stop-after'] as const)
  if (values[key] !== undefined && (!/^\d+$/.test(values[key]!) || Number(values[key]) > 1_000_000))
    throw new Error(`Invalid --${key}`)
if (!/^[a-z]{2}(,[a-z]{2})*$/.test(values['pilot-ufs']!)) throw new Error('Invalid --pilot-ufs')
const pool = createPool()
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
  } else if (!values.migrate)
    console.log(
      JSON.stringify(
        await importElection(pool, {
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
        }),
        null,
        2,
      ),
    )
} finally {
  await pool.end()
}
