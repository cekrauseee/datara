import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPool, migrate } from '../src/db/index.js'
import {
  importElection,
  publishPublication,
  validatePublication,
} from '../src/modules/elections/ingestion/import.js'
import { normalizeUnified } from '../src/modules/elections/ingestion/normalize.js'
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
}
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
          'offline replay, interrupted publication, idempotent resume, lower correction replacement, incompatible candidacy FK, aggregate nonduplication, retained prior publication, IBGE state IDs',
      }),
    )
  } finally {
    client.release()
  }
} finally {
  await pool.end()
  await admin.query(`DROP SCHEMA ${schema} CASCADE`)
  await admin.end()
}
