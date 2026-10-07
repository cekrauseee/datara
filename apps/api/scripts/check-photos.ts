import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config.js'
import { createPool } from '../src/db/index.js'
import { downloadPhotos } from '../src/modules/elections/ingestion/photos.js'
import { atomicWrite, hash } from '../src/modules/elections/ingestion/source.js'
import { candidatePhotoFile } from '../src/modules/elections/presentation.js'

if (!process.env.TEST_DATABASE_URL || !process.env.ELECTION_ARCHIVE_DIR)
  throw new Error(
    'TEST_DATABASE_URL and ELECTION_ARCHIVE_DIR are required; use a published pilot with two archived photo sources',
  )
const pool = createPool(process.env.TEST_DATABASE_URL)
const dir = await mkdtemp(join(tmpdir(), 'datara-official-photos-'))
let manifestPath: string | undefined
let savedManifest: Buffer | undefined
try {
  const publicationId = (await pool.query('SELECT active_publication_id FROM editions')).rows[0]
    ?.active_publication_id
  assert.ok(
    publicationId,
    'Load the real pilot and archive one presidential and one Acre deputy photo first',
  )
  const documents = (await pool.query('SELECT count(*)::integer n FROM source_documents')).rows[0].n
  const contests = ['BR-2026-1:6257:1:br', 'BR-2026-1:6259:6:ac']
  for (const contestId of contests) {
    const result = await downloadPhotos(pool, {
      publicationId,
      contestId,
      limit: 1,
      offline: true,
      archiveDir: process.env.ELECTION_ARCHIVE_DIR,
      photoDirectory: dir,
    })
    assert.equal(result.downloaded, 1)
    assert.equal(result.failed, 0)
  }
  const presentationFile = join(dir, 'presentation.json')
  await writeFile(presentationFile, JSON.stringify({ candidates: {}, parties: {} }))
  const app = await createApp(
    pool,
    readConfig({
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      PHOTO_DIRECTORY: dir,
      ELECTION_PRESENTATION_FILE: presentationFile,
    }),
  )
  for (const contestId of contests) {
    const candidate = (
      await pool.query(
        'SELECT id,number FROM candidacies WHERE publication_id=$1 AND contest_id=$2 ORDER BY id LIMIT 1',
        [publicationId, contestId],
      )
    ).rows[0]
    const response = await app.request(
      `/contests/${encodeURIComponent(contestId)}/candidates?q=${candidate.number}`,
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    const item = body.items.find((c: { id: string }) => c.id === candidate.id)
    assert.equal(item.photoUrl, `/assets/${candidatePhotoFile(candidate.id)}`)
    const asset = await app.request(item.photoUrl)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('Content-Type') ?? '', /^image\/jpeg/)
    assert.equal(
      hash(Buffer.from(await asset.arrayBuffer())),
      hash(await readFile(join(dir, candidatePhotoFile(candidate.id)))),
    )
  }
  assert.equal(
    (await pool.query('SELECT count(*)::integer n FROM source_documents')).rows[0].n,
    documents,
    'Optional photos must not mutate the published voting manifest',
  )
  // An edited generated file is a local choice, not permission to overwrite it during replay.
  const first = (
    await pool.query(
      'SELECT id FROM candidacies WHERE publication_id=$1 AND contest_id=$2 ORDER BY id LIMIT 1',
      [publicationId, contests[0]],
    )
  ).rows[0]
  await mkdir(join(dir, 'photos'), { recursive: true })
  await writeFile(join(dir, candidatePhotoFile(first.id)), 'Local edited photo')
  const preserved = await downloadPhotos(pool, {
    publicationId,
    contestId: contests[0],
    limit: 1,
    offline: true,
    archiveDir: process.env.ELECTION_ARCHIVE_DIR,
    photoDirectory: dir,
  })
  assert.equal(preserved.preservedLocal, 1)
  assert.equal(
    await readFile(join(dir, candidatePhotoFile(first.id)), 'utf8'),
    'Local edited photo',
  )
  console.log(
    'Two real official JPEGs replayed offline -> candidate photoUrl -> local HTTP JPEG/hash; voting manifest and local edits preserved',
  )
} finally {
  await pool.end()
  if (manifestPath && savedManifest) await atomicWrite(manifestPath, savedManifest)
  await rm(dir, { recursive: true, force: true })
}
