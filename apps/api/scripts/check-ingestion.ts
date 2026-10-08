import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPool, migrate } from '../src/db/index.js'
import { InterruptedError, sleep } from '../src/modules/elections/ingestion/fetch.js'
import {
  type ImportResult,
  importElection,
  publishPublication,
  validatePublication,
} from '../src/modules/elections/ingestion/import.js'
import { normalizeUnified } from '../src/modules/elections/ingestion/normalize.js'
import { hash } from '../src/modules/elections/ingestion/source.js'
import type { ImportOptions, UnifiedResult } from '../src/modules/elections/ingestion/types.js'

if (!process.env.TEST_DATABASE_URL || !process.env.ELECTION_ARCHIVE_DIR)
  throw new Error(
    'TEST_DATABASE_URL and ELECTION_ARCHIVE_DIR are required; point to an isolated test database and complete official pilot archive',
  )
const admin = createPool(process.env.TEST_DATABASE_URL)
const schema = `ingestion_${randomUUID().replaceAll('-', '')}`
await admin.query(`CREATE SCHEMA ${schema}`)
const url = new URL(process.env.TEST_DATABASE_URL)
url.searchParams.set(
  'options',
  `${url.searchParams.get('options') ?? ''} -csearch_path=${schema}`.trim(),
)
const pool = createPool(url.toString())
const options: ImportOptions = {
  scope: 'pilot',
  archiveDir: process.env.ELECTION_ARCHIVE_DIR,
  offline: true,
  pilotUfs: ['ac', 'df', 'pe', 'zz'],
  municipalitiesPerUf: 1,
  sectionsPerUf: 2,
  publish: false,
  progressIntervalMs: 0,
}
const archives: string[] = []

const TABLES: Record<string, string> = {
  areas:
    'id,level,name,uf,municipality_code,zone_code,section_code,feature_id,parent_id,principal_area_id',
  contests: 'id,election_id,office_code,office_name,scope_area_id,seats,vote_type',
  parties: 'number,abbreviation,name',
  candidacies:
    'contest_id,id,official_id,number,name,display_name,party_number,status,vote_destination,elected,coalition,federation,running_mates',
  candidate_results: 'contest_id,area_id,candidate_id,votes,official_percentage,vote_destination',
  party_results:
    'contest_id,area_id,party_number,nominal_votes,valid_nominal_votes,legend_votes,valid_legend_votes',
  votable_results: 'contest_id,area_id,number,vote_type,party_number,votes',
  import_tasks: 'url,kind,context,state',
  area_results: `contest_id,area_id,(SELECT url FROM source_documents s WHERE s.id=source_id),source_kind,status,complete,
   eligible,turnout,abstentions,total_votes,valid_votes,nominal_votes,legend_votes,blank_votes,null_votes,sections_total,sections_counted,metadata`,
  source_documents: 'url,sha256,archive_path,kind,generated_at,metadata',
}
// Row counts and content digests of everything a publication normalized, without its UUIDs.
async function digest(pub: string, collectedAt = true) {
  const result: Record<string, string> = {}
  for (const [table, columns] of Object.entries(TABLES)) {
    const selected =
      table === 'source_documents' && collectedAt ? `${columns},collected_at` : columns
    const row = (
      await pool.query(
        `SELECT count(*)::integer n,md5(coalesce(string_agg(x,E'\\n' ORDER BY x),'')) d
         FROM (SELECT (r)::text x FROM (SELECT ${selected} FROM ${table} WHERE publication_id=$1) r) s`,
        [pub],
      )
    ).rows[0]
    result[table] = `${row.n}:${row.d}`
  }
  return result
}
// Every manifest row has verified bytes, and no write was left half done.
async function verifyArchive(directory: string, pub: string) {
  for (const sub of ['sha256', 'urls'])
    assert.ok(
      (await readdir(join(directory, sub)).catch(() => [])).every((f) => !f.endsWith('.tmp')),
      `temporary file left in ${sub}`,
    )
  const rows = (
    await pool.query(
      'SELECT url,sha256,archive_path FROM source_documents WHERE publication_id=$1',
      [pub],
    )
  ).rows
  for (const row of rows)
    assert.equal(hash(await readFile(join(directory, row.archive_path))), row.sha256, row.url)
  return rows.length
}
// The official TSE server, played from the archived pilot bytes: no network requests.
function scriptedTse(script: {
  missing?: string
  replace?: Map<string, unknown>
  interrupt?: { after: number; controller: AbortController }
}) {
  const requests: string[] = []
  let served = 0
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push(url)
    await sleep(Math.random() * 3, [init?.signal ?? undefined])
    if (url === script.missing) return new Response(null, { status: 404 })
    let bytes: Buffer
    if (script.replace?.has(url)) bytes = Buffer.from(JSON.stringify(script.replace.get(url)))
    else
      try {
        const reference = JSON.parse(
          await readFile(
            join(options.archiveDir, 'urls', `${hash(Buffer.from(url))}.json`),
            'utf8',
          ),
        )
        bytes = await readFile(join(options.archiveDir, 'sha256', reference.sha256))
      } catch {
        return new Response(null, { status: 404 })
      }
    if (script.interrupt && ++served === script.interrupt.after)
      script.interrupt.controller.abort(new InterruptedError('SIGINT'))
    return new Response(new Uint8Array(bytes))
  }) as typeof fetch
  return { fetch: fake, requests }
}
async function temporaryArchive() {
  const directory = await mkdtemp(join(tmpdir(), 'datara-ingestion-archive-'))
  archives.push(directory)
  return directory
}
function expectPaused(result: ImportResult, reason: string) {
  assert.equal(result.status, 'paused', JSON.stringify(result))
  if (result.status !== 'paused') throw new Error('Expected a paused import')
  assert.equal(result.reason, reason, JSON.stringify(result))
  return result
}
const state = async (pub: string) =>
  (await pool.query('SELECT state,error FROM import_runs WHERE publication_id=$1', [pub])).rows[0]
try {
  await migrate(pool)
  assert.equal(
    (await pool.query('SELECT count(*)::integer AS n FROM publications')).rows[0].n,
    0,
    'Use an empty isolated verification database',
  )
  const paused = await importElection(pool, { ...options, stopAfter: 1 })
  assert.equal(paused.status, 'paused')
  assert.equal(
    (await pool.query('SELECT active_publication_id FROM editions')).rows[0].active_publication_id,
    null,
  )
  const before = (await pool.query('SELECT count(*)::integer AS n FROM area_results')).rows[0].n
  await importElection(pool, { ...options, publicationId: paused.publicationId, stopAfter: 0 })
  assert.equal(
    (await pool.query('SELECT count(*)::integer AS n FROM area_results')).rows[0].n,
    before,
  )
  const prepared = await importElection(pool, { ...options, publicationId: paused.publicationId })
  assert.equal(prepared.status, 'ready')
  const sourceCount = (await pool.query('SELECT count(*)::integer AS n FROM source_documents'))
    .rows[0].n
  const resultCount = (await pool.query('SELECT count(*)::integer AS n FROM area_results')).rows[0]
    .n
  await importElection(pool, { ...options, publicationId: paused.publicationId })
  assert.equal(
    (await pool.query('SELECT count(*)::integer AS n FROM source_documents')).rows[0].n,
    sourceCount,
  )
  assert.equal(
    (await pool.query('SELECT count(*)::integer AS n FROM area_results')).rows[0].n,
    resultCount,
  )
  assert.equal(
    (
      await pool.query("SELECT feature_id FROM areas WHERE publication_id=$1 AND id='ac'", [
        paused.publicationId,
      ])
    ).rows[0].feature_id,
    '12',
  )
  const client = await pool.connect()
  try {
    await publishPublication(client, paused.publicationId)
    const pub = paused.publicationId
    const raw = (
      await client.query(
        "SELECT s.* FROM source_documents s JOIN area_results r ON r.source_id=s.id WHERE r.publication_id=$1 AND r.area_id='br' AND r.source_kind='EA20'",
        [pub],
      )
    ).rows[0]
    const data = JSON.parse(
      await readFile(join(options.archiveDir, raw.archive_path), 'utf8'),
    ) as UnifiedResult
    const candidate = data.carg[0]!.agr[0]!.par[0]!.cand[0]!
    const old = Number(candidate.vap)
    candidate.vap = String(old - 1)
    await client.query('BEGIN')
    // Synthetic correction of one official candidate count tests replacement, then rolls back.
    await normalizeUnified(
      client,
      pub,
      { id: raw.id, bytes: Buffer.alloc(0), sha256: raw.sha256, url: raw.url },
      data,
      { contestId: 'BR-2026-1:6257:1:br', areaId: 'br', electionId: '6257', officeCode: '1' },
    )
    assert.equal(
      Number(
        (
          await client.query(
            'SELECT votes FROM candidate_results WHERE publication_id=$1 AND contest_id=$2 AND area_id=$3 AND candidate_id=$4',
            [pub, 'BR-2026-1:6257:1:br', 'br', `BR-2026-1:6257:1:br:${candidate.sqcand}`],
          )
        ).rows[0].votes,
      ),
      old - 1,
    )
    await client.query('ROLLBACK')
    await client.query('BEGIN')
    const altered = await client.query(
      "UPDATE area_results SET total_votes=total_votes+1 WHERE publication_id=$1 AND area_id='zz:29254:0001' AND source_kind='EA20'",
      [pub],
    )
    assert.equal(altered.rowCount, 1)
    await assert.rejects(
      validatePublication(client, pub, 'national'),
      /Unreconciled complete zones/,
    )
    await client.query('ROLLBACK')

    await client.query('BEGIN')
    const other = (
      await client.query(
        "SELECT id FROM candidacies WHERE publication_id=$1 AND contest_id!='BR-2026-1:6257:1:br' LIMIT 1",
        [pub],
      )
    ).rows[0].id
    await assert.rejects(
      client.query(
        `INSERT INTO candidate_results(publication_id,contest_id,area_id,candidate_id,votes) VALUES($1,'BR-2026-1:6257:1:br','br',$2,1)`,
        [pub, other],
      ),
      { code: '23503' },
    )
    await client.query('ROLLBACK')
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::integer AS n FROM area_results r JOIN areas a ON a.publication_id=r.publication_id AND a.id=r.area_id WHERE a.principal_area_id IS NOT NULL',
        )
      ).rows[0].n,
      0,
    )
    assert.ok(
      (
        await client.query(
          'SELECT count(*)::integer AS n FROM areas WHERE principal_area_id IS NOT NULL',
        )
      ).rows[0].n > 0,
    )
    await assert.rejects(importElection(pool, { ...options, publicationId: pub }), /immutable/)
    assert.deepEqual(
      (
        await client.query(
          'SELECT p.status,r.state FROM publications p JOIN import_runs r ON r.publication_id=p.id WHERE p.id=$1',
          [pub],
        )
      ).rows[0],
      { status: 'published', state: 'published' },
    )
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::integer n FROM areas WHERE uf='zz' AND feature_id IS NOT NULL",
        )
      ).rows[0].n,
      0,
    )
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::integer n FROM area_results WHERE publication_id=$1 AND area_id='df:97012:0002:0471' AND source_kind='BU'",
          [pub],
        )
      ).rows[0].n,
      5,
    )
    const council = (
      await client.query(
        "SELECT eligible,turnout,total_votes,valid_votes FROM area_results WHERE publication_id=$1 AND contest_id='BR-2026-1:6261:25:pe:30015' AND area_id='pe:30015:0004:0146'",
        [pub],
      )
    ).rows[0]
    assert.deepEqual(council, {
      eligible: '381',
      turnout: '261',
      total_votes: '261',
      valid_votes: null,
    })
    const exterior = (
      await client.query(
        "SELECT eligible,turnout FROM area_results WHERE publication_id=$1 AND area_id='zz:29254:0001:0001'",
        [pub],
      )
    ).rows[0]
    assert.deepEqual(exterior, { eligible: '91', turnout: '44' })
    // Online acquisition through the prefetch window against the scripted TSE: a missing source
    // pauses with its URL, an interruption pauses after the current unit, and the resumed
    // publication equals the sequential offline one.
    const network = { concurrency: 4, rate: 100 }
    const online = { ...options, offline: false, archiveDir: await temporaryArchive() }
    const missing = (
      await client.query(
        "SELECT url FROM import_tasks WHERE publication_id=$1 AND kind='EA20' AND context->>'areaId'='ac:01066:0004' ORDER BY url LIMIT 1",
        [pub],
      )
    ).rows[0].url
    const first = scriptedTse({ missing })
    const stopped = expectPaused(
      await importElection(pool, { ...online, network: { ...network, fetch: first.fetch } }),
      'source-unavailable',
    )
    const acquired = stopped.publicationId
    assert.equal((await state(acquired)).state, 'paused')
    assert.ok((await state(acquired)).error.includes(missing))
    assert.equal(first.requests.filter((url) => url === missing).length, 1)
    await verifyArchive(online.archiveDir, acquired)
    const controller = new AbortController()
    const second = scriptedTse({ interrupt: { after: 60, controller } })
    const interruptedRun = expectPaused(
      await importElection(pool, {
        ...online,
        publicationId: acquired,
        signal: controller.signal,
        network: { ...network, fetch: second.fetch },
      }),
      'interrupted',
    )
    assert.ok(interruptedRun.processed > 0)
    assert.equal((await state(acquired)).state, 'paused')
    await verifyArchive(online.archiveDir, acquired)
    const third = scriptedTse({})
    const resumed = await importElection(pool, {
      ...online,
      publicationId: acquired,
      network: { ...network, fetch: third.fetch },
    })
    assert.equal(resumed.status, 'ready')
    assert.equal(await verifyArchive(online.archiveDir, acquired), sourceCount)
    assert.deepEqual(await digest(acquired, false), await digest(pub, false))
    const requests = [...first.requests, ...second.requests, ...third.requests]
    const unique = new Set(requests).size
    assert.equal(unique, sourceCount)
    // Repeats: the source that was missing once, plus in-flight prefetches aborted by each pause.
    assert.ok(
      requests.length - unique <= 1 + 2 * network.concurrency,
      `${requests.length} requests`,
    )

    // An estimate builds the inventory and downloads only catalogs.
    const statusArchive = await temporaryArchive()
    const catalogsOnly = scriptedTse({})
    const estimated = expectPaused(
      await importElection(pool, {
        ...options,
        offline: false,
        archiveDir: statusArchive,
        estimate: true,
        network: { ...network, fetch: catalogsOnly.fetch },
      }),
      'estimate',
    )
    assert.equal(estimated.processed, 0)
    assert.equal(catalogsOnly.requests.length, 8, 'an estimate downloads only EA11, EA12 and EA16')
    assert.match(estimated.estimate!.note, /no EA20, EA18 or BU result file was downloaded/)
    assert.deepEqual(estimated.estimate!.tasks, {
      EA18: { total: 7, pending: 7 },
      EA20: { total: 261, pending: 261 },
    })
    assert.equal(estimated.estimate!.requests, 261 + 2 * 7)

    // Offline at concurrency 4: options recorded before operational parameters existed still
    // resume, unit failures are recorded while the run continues, EA20 failures hold back
    // section bulletins, a mid-queue stop resumes, and the result equals the sequential import.
    const planned = expectPaused(
      await importElection(pool, { ...options, estimate: true, network: { concurrency: 4 } }),
      'estimate',
    )
    const replay = planned.publicationId
    const stored = (
      await client.query('SELECT options FROM import_runs WHERE publication_id=$1', [replay])
    ).rows[0].options
    assert.deepEqual(Object.keys(stored).sort(), [
      'archiveDir',
      'municipalitiesPerUf',
      'offline',
      'pilotUfs',
      'scope',
      'sectionsPerUf',
    ])
    await client.query('UPDATE import_runs SET options=$2 WHERE publication_id=$1', [
      replay,
      {
        scope: 'pilot',
        pilotUfs: ['ac', 'df', 'pe', 'zz'],
        archiveDir: options.archiveDir,
        sectionsPerUf: 2,
        municipalitiesPerUf: 1,
      },
    ])
    const broken = (
      await client.query(
        "SELECT url FROM import_tasks WHERE publication_id=$1 AND kind='EA20' AND context->>'areaId'='ac:01066' AND context->>'officeCode'='1'",
        [replay],
      )
    ).rows[0].url
    const setElection = (election: string) =>
      client.query(
        `UPDATE import_tasks SET context=jsonb_set(context,'{electionId}',to_jsonb($3::text))
         WHERE publication_id=$1 AND url=$2`,
        [replay, broken, election],
      )
    await setElection('0000')
    const resume = { ...options, publicationId: replay, network: { concurrency: 4 } }
    const partial = expectPaused(
      await importElection(pool, { ...resume, keepGoing: true, stopAfter: 150 }),
      'stop-after',
    )
    assert.equal(partial.processed, 150)
    assert.deepEqual(
      partial.failures?.map((failure) => failure.url),
      [broken],
    )
    const held = expectPaused(
      await importElection(pool, { ...resume, keepGoing: true }),
      'unit-failures',
    )
    assert.match(held.error!, /EA20 failures must be resolved before section bulletins/)
    assert.deepEqual(
      (
        await client.query(
          "SELECT kind,count(*)::integer n FROM import_tasks WHERE publication_id=$1 AND state='pending' GROUP BY kind ORDER BY kind",
          [replay],
        )
      ).rows,
      [
        { kind: 'EA18', n: 7 },
        { kind: 'EA20', n: 1 },
      ],
    )
    await assert.rejects(importElection(pool, resume), /Unexpected EA20 contest/)
    await setElection('6257')
    assert.equal((await importElection(pool, resume)).status, 'ready')
    assert.deepEqual(await digest(replay), await digest(pub))
    const interrupted = await importElection(pool, { ...options, stopAfter: 1 })
    assert.equal(
      (await client.query('SELECT active_publication_id FROM editions')).rows[0]
        .active_publication_id,
      pub,
    )
    const fresh = await importElection(pool, {
      ...options,
      publicationId: interrupted.publicationId,
      publish: true,
    })
    assert.equal(fresh.status, 'published')
    assert.notEqual(fresh.publicationId, pub)
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::integer AS n FROM publications WHERE status='published'",
        )
      ).rows[0].n,
      2,
    )
    assert.equal(
      (await client.query('SELECT active_publication_id FROM editions')).rows[0]
        .active_publication_id,
      fresh.publicationId,
    )
    console.log(
      JSON.stringify({
        publicationId: fresh.publicationId,
        firstPublication: pub,
        sourceCount,
        resultCount,
        checks:
          'offline replay, interrupted publication, idempotent resume, lower correction replacement, incompatible candidacy FK, aggregate nonduplication, retained prior publication, IBGE state IDs, scripted online acquisition with 404 pause/interruption/resume equal to offline, estimate without result downloads, legacy resume options, keep-going with EA20 gate, mid-queue stop at concurrency 4 equal to sequential',
      }),
    )
  } finally {
    client.release()
  }
} finally {
  await pool.end()
  await admin.query(`DROP SCHEMA ${schema} CASCADE`)
  await admin.end()
  for (const directory of archives) await rm(directory, { recursive: true, force: true })
}
