import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config.js'
import { createPool, migrate } from '../src/db/index.js'
import { importElection } from '../src/modules/elections/ingestion/import.js'
import { measure } from '../src/modules/elections/metrics.js'

if (!process.env.TEST_DATABASE_URL || !process.env.ELECTION_ARCHIVE_DIR)
  throw new Error('TEST_DATABASE_URL and ELECTION_ARCHIVE_DIR are required')
const basePool = createPool(process.env.TEST_DATABASE_URL)
const name = `api_check_${randomUUID().replaceAll('-', '')}`
const url = new URL(process.env.TEST_DATABASE_URL!)
url.searchParams.set('options', `-c search_path=${name}`)
const pool = createPool(url.toString())
try {
  await basePool.query(`CREATE SCHEMA ${name}`)
  await migrate(pool)
  const imported = await importElection(pool, {
    scope: 'pilot',
    archiveDir:
      process.env.ELECTION_ARCHIVE_DIR ??
      new URL('../../../.data/elections', import.meta.url).pathname,
    offline: true,
    pilotUfs: ['ac', 'df', 'pe', 'zz'],
    municipalitiesPerUf: 1,
    sectionsPerUf: 2,
  })
  const publicationId = imported.publicationId
  assert.equal(imported.status, 'published')
  const app = await createApp(pool, readConfig({ DATABASE_URL: url.toString() }))
  async function request(path: string, status = 200) {
    const response = await app.request(path)
    const body = await response.json()
    assert.equal(response.status, status, JSON.stringify(body))
    assert.ok(response.headers.get('X-Request-Id'))
    return body
  }
  const list = await request('/elections?country=BR&year=2026&round=1')
  assert.equal(list.items[0].publication.id, publicationId)
  const contest = 'BR-2026-1:6257:1:br'
  const candidates = await request(`/contests/${contest}/candidates?limit=1`)
  const candidate = candidates.items[0]
  assert.ok(
    candidate.photoUrl === null || /^\/assets\/photos\/[a-f0-9]{64}\.jpg$/.test(candidate.photoUrl),
  )
  assert.match(candidate.color, /^#[a-fA-F0-9]{6}$/)
  const first = await request(`/contests/${contest}/results?areaId=br&limit=1`)
  const next = await request(`/contests/${contest}/results?areaId=br&limit=25`)
  const denominator = Number(
    (
      await pool.query(
        'SELECT sum(votes) n FROM candidate_results WHERE publication_id=$1 AND contest_id=$2 AND area_id=$3',
        [publicationId, contest, 'br'],
      )
    ).rows[0].n,
  )
  assert.equal(first.summary.candidateVoteDenominator, denominator)
  assert.equal(next.summary.candidateVoteDenominator, denominator)
  assert.equal(first.candidates[0].share.basis, 'recordedCandidateVotesSum')
  assert.equal(
    first.candidates[0].officialPercentage.basis,
    'TSE pvapn (official competing-candidate basis)',
  )
  const senate = (
    await pool.query(
      "SELECT r.contest_id,r.area_id,r.total_votes,r.turnout,r.eligible FROM area_results r JOIN contests c ON c.publication_id=r.publication_id AND c.id=r.contest_id WHERE r.publication_id=$1 AND c.office_code='5' AND r.source_kind='BU' ORDER BY r.area_id LIMIT 1",
      [publicationId],
    )
  ).rows[0]
  const bulletin = await request(`/contests/${senate.contest_id}/results?areaId=${senate.area_id}`)
  assert.equal(bulletin.totals.totalVotes, Number(senate.total_votes))
  assert.equal(bulletin.totals.turnout, Number(senate.turnout))
  assert.equal(bulletin.totals.totalVotes, 2 * bulletin.totals.turnout)
  assert.equal(bulletin.totals.validVotes, null)
  assert.equal(bulletin.summary.shareBasis, 'printedNominalVotes')
  const shared = (
    await pool.query(
      "SELECT a.id,a.principal_area_id,r.contest_id FROM areas a JOIN area_results r ON r.publication_id=a.publication_id AND r.area_id=a.principal_area_id WHERE a.publication_id=$1 AND a.principal_area_id IS NOT NULL AND r.source_kind='BU' LIMIT 1",
      [publicationId],
    )
  ).rows[0]
  assert.ok(shared, 'Pilot needs an imported principal with aggregated child')
  const aggregate = await request(`/contests/${shared.contest_id}/results?areaId=${shared.id}`)
  const principal = await request(
    `/contests/${shared.contest_id}/results?areaId=${shared.principal_area_id}`,
  )
  assert.equal(aggregate.state, 'shared')
  assert.equal(aggregate.resultAreaId, shared.principal_area_id)
  assert.deepEqual(aggregate.totals, principal.totals)
  // Ranking sorts vote counts numerically; the pilot senator totals mix 5- and 6-digit counts.
  const senatorContest = 'BR-2026-1:6259:5:ac'
  const ranked = (
    await pool.query(
      'SELECT candidate_id,sum(votes)::text votes FROM candidate_results WHERE publication_id=$1 AND contest_id=$2 AND area_id=$3 GROUP BY candidate_id ORDER BY sum(votes) DESC,candidate_id',
      [publicationId, senatorContest, 'ac'],
    )
  ).rows as { candidate_id: string; votes: string }[]
  assert.ok(ranked.length >= 3, 'Pilot needs senator totals for AC')
  const lexicographic = [...ranked].sort((x, y) => y.votes.localeCompare(x.votes))[0]
  assert.notEqual(
    lexicographic.candidate_id,
    ranked[0].candidate_id,
    'Regression needs counts whose text order differs from numeric order',
  )
  const senator = await request(`/contests/${senatorContest}/results?areaId=ac&limit=3`)
  const tiedLeaders = ranked.filter((r) => r.votes === ranked[0].votes).map((r) => r.candidate_id)
  assert.deepEqual(senator.summary.leaders, tiedLeaders)
  assert.equal(
    senator.summary.margin.votes,
    tiedLeaders.length > 1 ? 0 : Number(ranked[0].votes) - Number(ranked[1].votes),
  )
  assert.equal(
    senator.summary.seatCutoffMargin.votes,
    Number(ranked[1].votes) - Number(ranked[2].votes),
  )
  assert.equal(senator.candidates[0].candidate.id, ranked[0].candidate_id)
  const outside = await request(`/contests/${senate.contest_id}/results?areaId=br`, 400)
  assert.equal(outside.error.code, 'INCOMPATIBLE_AREA')
  const mismatch = await request(
    `/contests/${senate.contest_id}/distribution?candidateId=${candidate.id}`,
    400,
  )
  assert.equal(mismatch.error.code, 'INCOMPATIBLE_CANDIDATE')
  const invalid = await request('/elections/BR-2026-1/areas?level=section&limit=101', 400)
  assert.equal(invalid.error.code, 'INVALID_PARAMETERS')
  assert.ok(invalid.error.details.length)
  const notPublished = await request(`/elections/BR-2026-1?publicationId=${randomUUID()}`, 404)
  assert.equal(notPublished.error.code, 'PUBLICATION_NOT_FOUND')
  const source = await request(`/sources/${first.provenance.sourceIds[0]}`)
  assert.match(source.sha256, /^[a-f0-9]{64}$/)
  assert.equal('archive_path' in source, false)
  assert.equal('metadata' in source, false)
  const distribution = await request(
    `/contests/${contest}/distribution?candidateId=${candidate.id}&areaId=ac&level=municipality&limit=1`,
  )
  assert.equal(distribution.items.length, 1)
  assert.equal(distribution.publicationId, publicationId)
  // Territory expansion stops at the requested level without changing which areas are counted.
  const acMunicipalities = Number(
    (
      await pool.query(
        "SELECT count(*) FROM areas WHERE publication_id=$1 AND level='municipality' AND uf='ac'",
        [publicationId],
      )
    ).rows[0].count,
  )
  assert.equal(distribution.pagination.total, acMunicipalities)
  const within = (query: string, status?: number) =>
    request(`/contests/${contest}/distribution?candidateId=${candidate.id}&${query}`, status)
  assert.equal((await within('areaId=br&level=state&limit=1')).pagination.total, 28)
  assert.equal((await within('areaId=ac&level=country')).pagination.total, 0)
  const mapResponse = await app.request(`/contests/${contest}/map?level=municipality&metric=leader`)
  const map = await mapResponse.json()
  assert.equal(mapResponse.status, 200)
  assert.equal(map.items.length, 5571)
  assert.ok(
    map.items.some((r: { value: number | null }) => r.value === null),
    'Pilot missing results must remain null',
  )
  const states = await request(`/contests/${contest}/map?level=state&metric=turnout`)
  assert.ok(states.items.some((r: { featureId: string }) => r.featureId === '12'))
  const region = await request(`/contests/${contest}/results?areaId=region:north`)
  assert.equal(region.provenance.sourceKind, 'aggregate')
  assert.equal(region.complete, true)
  const exterior = await request(`/contests/${contest}/results?areaId=exterior`)
  assert.equal(exterior.area.featureId, null)
  assert.equal(exterior.state, 'available')
  const schema = await request('/openapi.json')
  assert.equal(Object.keys(schema.paths).length, 9)
  assert.ok(schema.components.schemas.AreaResult)
  assert.equal(measure(0, 0, 'test').state, 'undefined')
  assert.equal(measure(null, 1, 'test').state, 'unavailable')

  // Synthetic tie/zero edge values stay within this disposable schema and are restored.
  const originalVotes = (
    await pool.query(
      'SELECT candidate_id,votes::text votes FROM candidate_results WHERE publication_id=$1 AND contest_id=$2 AND area_id=$3',
      [publicationId, contest, 'br'],
    )
  ).rows
  await pool.query(
    'UPDATE candidate_results SET votes=0 WHERE publication_id=$1 AND contest_id=$2 AND area_id=$3',
    [publicationId, contest, 'br'],
  )
  const tie = await request(`/contests/${contest}/results?areaId=br&limit=1`)
  assert.equal(tie.summary.tie, true)
  assert.equal(tie.summary.leaders.length, originalVotes.length)
  assert.equal(tie.summary.margin.votes, 0)
  assert.equal(tie.candidates[0].share.value, null)
  assert.equal(tie.candidates[0].share.state, 'undefined')
  // Counts with different digit lengths must rank numerically, not lexicographically.
  const [top, runnerUp, third] = originalVotes
    .map((v: { candidate_id: string }) => v.candidate_id)
    .sort()
  await pool.query(
    'UPDATE candidate_results SET votes=CASE candidate_id WHEN $4 THEN 100000 WHEN $5 THEN 99999 WHEN $6 THEN 9999 ELSE 0 END WHERE publication_id=$1 AND contest_id=$2 AND area_id=$3',
    [publicationId, contest, 'br', top, runnerUp, third],
  )
  const digits = await request(`/contests/${contest}/results?areaId=br&limit=3`)
  assert.deepEqual(digits.summary.leaders, [top])
  assert.equal(digits.summary.tie, false)
  assert.equal(digits.summary.margin.votes, 1)
  assert.equal(digits.candidates[0].candidate.id, top)
  assert.equal(digits.candidates[1].candidate.id, runnerUp)
  await pool.query(
    "UPDATE candidate_results c SET votes=v.votes::bigint FROM jsonb_to_recordset($3::jsonb) AS v(candidate_id text,votes text) WHERE c.publication_id=$1 AND c.contest_id=$2 AND c.area_id='br' AND c.candidate_id=v.candidate_id",
    [publicationId, contest, JSON.stringify(originalVotes)],
  )

  // A new active data publication does not change explicitly pinned related reads.
  const replacement = await importElection(pool, {
    scope: 'pilot',
    archiveDir:
      process.env.ELECTION_ARCHIVE_DIR ??
      new URL('../../../.data/elections', import.meta.url).pathname,
    offline: true,
    pilotUfs: ['ac', 'df', 'pe', 'zz'],
    municipalitiesPerUf: 1,
    sectionsPerUf: 2,
  })
  const current = await request('/elections/BR-2026-1')
  assert.equal(current.publication.id, replacement.publicationId)
  const pinned = await request(
    `/contests/${contest}/results?areaId=br&publicationId=${publicationId}`,
  )
  assert.equal(pinned.publicationId, publicationId)
  assert.deepEqual(pinned.totals, first.totals)
  const pinnedMap = await request(
    `/contests/${contest}/map?areaId=ac&publicationId=${publicationId}`,
  )
  assert.equal(pinnedMap.publicationId, publicationId)
  console.log(
    JSON.stringify(
      {
        checks: 'API integration passed',
        publicationId,
        mapFeatures: map.items.length,
        mapBytes: Buffer.byteLength(JSON.stringify(map)),
        sourceKind: 'official archived pilot',
      },
      null,
      2,
    ),
  )
} finally {
  await pool.end()
  await basePool.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
  await basePool.end()
}
