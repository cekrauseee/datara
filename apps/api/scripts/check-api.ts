import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config.js'
import { createPool, migrate } from '../src/db/index.js'
import { classifyError } from '../src/http/errors.js'
import { importElection } from '../src/modules/elections/ingestion/import.js'
import { measure } from '../src/modules/elections/metrics.js'

if (!process.env.TEST_DATABASE_URL || !process.env.ELECTION_ARCHIVE_DIR)
  throw new Error('TEST_DATABASE_URL and ELECTION_ARCHIVE_DIR are required')
const archiveDir = process.env.ELECTION_ARCHIVE_DIR
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
    archiveDir,
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
  async function cacheControl(path: string, status = 200) {
    const response = await app.request(path)
    assert.equal(response.status, status)
    return response.headers.get('Cache-Control')
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
  // A votable without a candidacy only hides the values it could change: the official pilot has
  // one such votable in three DF section results, each too small to alter the ranking.
  const section = 'df:97012:0002:0471'
  const governor = 'BR-2026-1:6259:3:df'
  const senatorDf = 'BR-2026-1:6259:5:df'
  const sectionSummary = async (contestId: string, areaId: string) => {
    const body = await request(`/contests/${contestId}/results?areaId=${areaId}&limit=1`)
    return { ...body.summary, unresolved: body.unresolvedVotables }
  }
  const governorSection = await sectionSummary(governor, section)
  assert.deepEqual(governorSection.unresolved, [
    { number: '55', voteType: '1', partyNumber: '55', votes: 1 },
  ])
  assert.deepEqual(governorSection.leaders, [`${governor}:70002553055`])
  assert.equal(governorSection.tie, false)
  assert.equal(governorSection.margin.votes, 12)
  assert.equal(governorSection.margin.basis, 'printedNominalVotes')
  // Type 5 (no candidate for the office) is printed only in bulletins; no archived one has it.
  const governorTotals = (await request(`/contests/${governor}/results?areaId=${section}&limit=1`))
    .totals
  assert.equal(governorTotals.noCandidateVotes, 0)
  assert.equal(
    governorTotals.nominalVotes + governorTotals.blankVotes + governorTotals.nullVotes,
    governorTotals.totalVotes,
  )
  assert.equal(first.totals.noCandidateVotes, null)
  const senateSection = await sectionSummary(senatorDf, 'df:97012:0002:0478')
  assert.equal(senateSection.unresolved[0].number, '555')
  assert.equal(senateSection.margin.votes, 4)
  assert.equal(senateSection.seatCutoffMargin.votes, 2)
  const deputySection = await sectionSummary('BR-2026-1:6259:6:df', section)
  assert.equal(deputySection.unresolved[0].number, '4577')
  assert.equal(deputySection.margin.votes, 16)
  // Synthetic unresolved votables (removed afterwards) reaching the leader, the runner-up or the
  // third candidacy (governor 101/89, Senate 172/168/166).
  const synthetic = async (contestId: string, areaId: string, votes: number) => {
    await pool.query(
      "INSERT INTO votable_results(publication_id,contest_id,area_id,number,vote_type,party_number,votes) VALUES($1,$2,$3,'999','1',NULL,$4) ON CONFLICT(publication_id,contest_id,area_id,number,vote_type) DO UPDATE SET votes=excluded.votes",
      [publicationId, contestId, areaId, votes],
    )
    return sectionSummary(contestId, areaId)
  }
  const unresolvedBasis = 'unresolvedPrintedCandidateVotes'
  try {
    const reachesLeader = await synthetic(governor, section, 101)
    assert.deepEqual([reachesLeader.leaders, reachesLeader.tie], [[], false])
    assert.deepEqual(reachesLeader.margin, {
      votes: null,
      percentagePoints: null,
      basis: unresolvedBasis,
    })
    const reachesRunnerUp = await synthetic(governor, section, 100)
    assert.deepEqual(reachesRunnerUp.leaders, governorSection.leaders)
    assert.equal(reachesRunnerUp.margin.votes, null)
    assert.equal(reachesRunnerUp.margin.basis, unresolvedBasis)
    const below = await synthetic(governor, section, 88)
    assert.equal(below.margin.votes, 12)
    assert.equal(below.margin.percentagePoints, governorSection.margin.percentagePoints)
    const reachesThird = await synthetic(senatorDf, 'df:97012:0002:0478', 167)
    assert.equal(reachesThird.leaders.length, 1)
    assert.equal(reachesThird.margin.votes, 4)
    assert.deepEqual(reachesThird.seatCutoffMargin, {
      votes: null,
      percentagePoints: null,
      basis: unresolvedBasis,
    })
  } finally {
    await pool.query(
      "DELETE FROM votable_results WHERE publication_id=$1 AND number='999' AND vote_type='1'",
      [publicationId],
    )
  }
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
  // Unknown candidacies are missing resources; those of another contest are incompatible.
  for (const path of [
    `/contests/${contest}/distribution?candidateId=nope`,
    `/contests/${contest}/map?metric=candidateVotes&candidateId=nope`,
  ])
    assert.equal((await request(path, 404)).error.code, 'CANDIDATE_NOT_FOUND')
  // An edition without an active publication reads as in the list; its data routes do not.
  await pool.query("UPDATE editions SET active_publication_id=NULL WHERE id='BR-2026-1'")
  try {
    assert.equal((await request('/elections/BR-2026-1')).publication, null)
    assert.equal((await request('/elections')).items[0].publication, null)
    assert.equal(
      (await request('/elections/BR-2026-1/contests', 404)).error.code,
      'PUBLICATION_NOT_FOUND',
    )
    assert.equal(
      (await request(`/elections/BR-2026-1?publicationId=${randomUUID()}`, 404)).error.code,
      'PUBLICATION_NOT_FOUND',
    )
    assert.equal(
      (await request(`/elections/BR-2026-1?publicationId=${publicationId}`)).publication.id,
      publicationId,
    )
  } finally {
    await pool.query("UPDATE editions SET active_publication_id=$1 WHERE id='BR-2026-1'", [
      publicationId,
    ])
  }
  assert.equal((await request('/elections/nope', 404)).error.code, 'ELECTION_NOT_FOUND')
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
  // Levels at or above the area cannot lie inside it; regions are below the country.
  for (const query of [
    'areaId=ac&level=country',
    'areaId=ac&level=state',
    'areaId=ac&level=region',
  ])
    assert.equal((await within(query, 400)).error.code, 'LEVEL_NOT_BELOW_SCOPE')
  assert.equal((await within('areaId=br&level=region')).pagination.total, 5)
  // Rankings are computed for the requested page only and match the full listing.
  const listed = await within('areaId=ac&level=municipality&limit=100')
  const index = listed.items.findIndex((item: { state: string }) => item.state === 'available')
  assert.ok(index >= 0, 'Pilot needs an AC municipality with results')
  const paged = await within(`areaId=ac&level=municipality&limit=1&offset=${index}`)
  assert.equal(paged.items[0].support.state, 'available')
  assert.deepEqual(paged.items, listed.items.slice(index, index + 1))
  // Levels more than two navigation steps below the area are refused; regions are not a step, so
  // the national default (every municipality) stays available.
  const municipality = listed.items[index].area
  const sections = Number(
    (
      await pool.query(
        "SELECT count(*) FROM areas WHERE publication_id=$1 AND level='section' AND uf='ac' AND municipality_code=$2",
        [publicationId, municipality.municipalityCode],
      )
    ).rows[0].count,
  )
  assert.ok(sections > 0, 'Pilot needs sections in the AC municipality with results')
  const sectionLevel = await within(`areaId=${municipality.id}&level=section&limit=1`)
  assert.equal(sectionLevel.pagination.total, sections)
  const municipalities = Number(
    (
      await pool.query(
        "SELECT count(*) FROM areas WHERE publication_id=$1 AND level='municipality'",
        [publicationId],
      )
    ).rows[0].count,
  )
  const national = await within('limit=1')
  assert.equal(national.scopeAreaId, 'br')
  assert.equal(national.pagination.total, municipalities)
  for (const query of [
    'areaId=br&level=zone',
    'areaId=br&level=section',
    'areaId=ac&level=section',
  ])
    assert.equal((await within(query, 400)).error.code, 'LEVEL_TOO_DEEP')
  const mapPath = `/contests/${contest}/map?level=municipality&metric=leader`
  const mapResponse = await app.request(mapPath)
  const mapText = await mapResponse.text()
  const map = JSON.parse(mapText)
  assert.equal(mapResponse.status, 200)
  assert.equal(mapResponse.headers.get('Content-Encoding'), null)
  assert.equal(map.items.length, 5571)
  assert.ok(
    map.items.some((r: { value: number | null }) => r.value === null),
    'Pilot missing results must remain null',
  )
  const gzipResponse = await app.request(mapPath, { headers: { 'Accept-Encoding': 'gzip' } })
  assert.equal(gzipResponse.status, 200)
  assert.equal(gzipResponse.headers.get('Content-Encoding'), 'gzip')
  assert.match(gzipResponse.headers.get('Vary') ?? '', /(^|,)\s*Accept-Encoding\s*(,|$)/i)
  const mapGzip = Buffer.from(await gzipResponse.arrayBuffer())
  assert.equal(gunzipSync(mapGzip).toString(), mapText)
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
  assert.ok(schema.components.schemas.ResultTotals.properties.noCandidateVotes)
  assert.equal(
    schema.paths['/elections/{electionId}'].get.responses['503'].description,
    'Database unavailable or query time limit exceeded',
  )
  assert.equal(measure(0, 0, 'test').state, 'undefined')
  assert.equal(measure(null, 1, 'test').state, 'unavailable')
  // A statement timeout is a query limit, not an unavailable database.
  const classified = (error: unknown) => {
    const { status, code } = classifyError(error)
    return [status, code]
  }
  assert.deepEqual(classified(Object.assign(new Error('canceled'), { code: '57014' })), [
    503,
    'QUERY_TIMEOUT',
  ])
  assert.deepEqual(classified(Object.assign(new Error('lost'), { code: '08006' })), [
    503,
    'DATABASE_UNAVAILABLE',
  ])
  assert.deepEqual(classified(new Error('timeout exceeded when trying to connect')), [
    503,
    'DATABASE_UNAVAILABLE',
  ])
  assert.deepEqual(classified(new Error('boom')), [500, 'INTERNAL_ERROR'])

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
    archiveDir,
    offline: true,
    pilotUfs: ['ac', 'df', 'pe', 'zz'],
    municipalitiesPerUf: 1,
    sectionsPerUf: 2,
  })
  const current = await request('/elections/BR-2026-1')
  assert.equal(current.publication.id, replacement.publicationId)
  const pinnedPath = `/contests/${contest}/results?areaId=br&publicationId=${publicationId}`
  const pinned = await request(pinnedPath)
  assert.equal(pinned.publicationId, publicationId)
  assert.deepEqual(pinned.totals, first.totals)
  // Only successful reads of an explicitly pinned publication are cacheable, for one hour because
  // editorial presentation can change without a new publication.
  assert.equal(await cacheControl(pinnedPath), 'public, max-age=3600')
  assert.equal(await cacheControl('/elections/BR-2026-1'), null)
  assert.equal(await cacheControl(`/elections?publicationId=${publicationId}`), null)
  assert.equal(await cacheControl(`/elections/BR-2026-1?publicationId=${randomUUID()}`, 404), null)
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
        mapGzipBytes: mapGzip.byteLength,
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
