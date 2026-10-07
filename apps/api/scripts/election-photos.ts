import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createPool } from '../src/db/index.js'
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
  },
})
if (
  values.limit !== undefined &&
  (!/^\d+$/.test(values.limit) || Number(values.limit) < 1 || Number(values.limit) > 100_000)
)
  throw new Error('--limit must be 1..100000')
const pool = createPool()
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
  })
  console.log(JSON.stringify(summary, null, 2))
  if (summary.failed) process.exitCode = 1
} finally {
  await pool.end()
}
