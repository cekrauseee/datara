import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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

  // Batch acquisition against a scripted server, into a temporary archive: concurrent requests,
  // retry after 503, 404 recorded as missing, persistent 500 as failed and retried on the next run.
  const batchArchive = join(dir, 'archive')
  const ea11 = (
    await pool.query(
      "SELECT archive_path FROM source_documents WHERE publication_id=$1 AND kind='EA11'",
      [publicationId],
    )
  ).rows[0].archive_path
  await mkdir(join(batchArchive, 'sha256'), { recursive: true })
  await copyFile(join(process.env.ELECTION_ARCHIVE_DIR, ea11), join(batchArchive, ea11))
  // Behavior by first-request order: missing, recovering after one 503, failing until fixed.
  const order = new Map<string, number>()
  const requests: string[] = []
  let active = 0
  let peak = 0
  let recovered = false
  let failing = true
  const server = (async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    if (!order.has(url)) order.set(url, order.size)
    const index = order.get(url)!
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    active--
    if (index === 0) return new Response(null, { status: 404 })
    if (index === 1 && !recovered) {
      recovered = true
      return new Response(null, { status: 503 })
    }
    if (index === 2 && failing) return new Response(null, { status: 500 })
    return new Response(new Uint8Array([255, 216, index, 1, 2, 3, 255, 217]))
  }) as typeof fetch
  const batch = {
    publicationId,
    contestId: contests[1],
    limit: 8,
    archiveDir: batchArchive,
    photoDirectory: join(dir, 'batch'),
    progressIntervalMs: 0,
    network: { concurrency: 4, rate: 100, retryDelayMs: 5, attempts: 2, fetch: server },
  }
  const acquired = await downloadPhotos(pool, batch)
  assert.deepEqual(
    [acquired.downloaded, acquired.missing, acquired.failed],
    [6, 1, 1],
    JSON.stringify(acquired),
  )
  assert.ok(peak > 1 && peak <= 4, `peak concurrency ${peak}`)
  assert.equal((await readdir(join(batchArchive, 'photo-urls'))).length, 8)
  const batchManifest = JSON.parse(await readFile(acquired.manifestPath, 'utf8'))
  assert.ok(acquired.manifestPath.startsWith(batchArchive))
  const selected = (
    await pool.query(
      'SELECT id FROM candidacies WHERE publication_id=$1 AND contest_id=$2 ORDER BY id LIMIT 8',
      [publicationId, contests[1]],
    )
  ).rows.map((row) => row.id)
  assert.deepEqual(Object.keys(batchManifest), selected)
  // Offline replay keeps the recorded failure; an online run retries only that photo.
  const replayed = await downloadPhotos(pool, { ...batch, offline: true })
  assert.deepEqual([replayed.downloaded, replayed.missing, replayed.failed], [6, 1, 1])
  const failedUrl = [...order].find(([, index]) => index === 2)![0]
  const before = requests.length
  failing = false
  const retried = await downloadPhotos(pool, batch)
  assert.deepEqual([retried.downloaded, retried.missing, retried.failed], [7, 1, 0])
  assert.deepEqual(requests.slice(before), [failedUrl])
  console.log(
    'Two real official JPEGs replayed offline -> candidate photoUrl -> local HTTP JPEG/hash; voting manifest and local edits preserved; scripted batch acquisition with bounded concurrency, retry, missing, failure and retry of failures',
  )
} finally {
  await pool.end()
  if (manifestPath && savedManifest) await atomicWrite(manifestPath, savedManifest)
  await rm(dir, { recursive: true, force: true })
}
