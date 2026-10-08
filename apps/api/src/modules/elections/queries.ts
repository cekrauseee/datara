import type { z } from '@hono/zod-openapi'
import type pg from 'pg'
import { ApiError } from '../../http/errors.js'
import type {
  AreaQuery,
  CandidateQuery,
  DistributionQuery,
  EditionQuery,
  MapQuery,
  PageQuery,
} from './contracts.js'
import { Level } from './contracts.js'
import { integer, measure, percentage } from './metrics.js'
import type { Presentation } from './presentation.js'

type AreaRow = {
  id: string
  level: string
  name: string
  uf: string | null
  municipality_code: string | null
  zone_code: string | null
  section_code: string | null
  feature_id: string | null
  parent_id: string | null
  principal_area_id: string | null
}
type ContestRow = {
  id: string
  office_code: string
  office_name: string
  election_id: string
  scope_area_id: string
  seats: number | null
  vote_type: string
}
type CandidateRow = {
  id: string
  official_id: string
  number: string
  name: string
  display_name: string
  party_number: string | null
  abbreviation: string | null
  party_name: string | null
  status: string | null
  vote_destination: string | null
  elected: boolean | null
  coalition: unknown
  federation: unknown
  running_mates: unknown[]
}
type ResultRow = {
  area_id: string
  source_kind: 'EA20' | 'BU' | 'aggregate'
  source_id?: string
  source_ids?: string[]
  status: string
  complete: boolean
  eligible: string | null
  turnout: string | null
  abstentions: string | null
  total_votes: string | null
  valid_votes: string | null
  nominal_votes: string | null
  legend_votes: string | null
  blank_votes: string | null
  null_votes: string | null
  sections_total: string | null
  sections_counted: string | null
  metadata: {
    generatedAt?: string
    emittedAt?: string
    officialPercentageBasis?: string
    candidateOmissionMeansZero?: boolean
    meaning?: string
  }
}
type Context = {
  client: pg.PoolClient
  publicationId: string
  coverage: Record<string, unknown>
  contest?: ContestRow
}
const candidateSelect = `SELECT c.*,p.abbreviation,p.name AS party_name FROM candidacies c LEFT JOIN parties p ON p.publication_id=c.publication_id AND p.number=c.party_number`
const resultColumns = [
  'eligible',
  'turnout',
  'abstentions',
  'total_votes',
  'valid_votes',
  'nominal_votes',
  'legend_votes',
  'blank_votes',
  'null_votes',
  'sections_total',
  'sections_counted',
]

export async function read<T>(pool: pg.Pool, run: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout='20s'")
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
function publication(row: {
  id: string
  scope: string
  published_at: Date | null
  coverage: Record<string, unknown>
}) {
  return {
    id: row.id,
    scope: row.scope,
    publishedAt: row.published_at?.toISOString() ?? null,
    coverage: row.coverage,
  }
}
export async function listElections(client: pg.PoolClient, query: z.output<typeof EditionQuery>) {
  const rows = await client.query(
    `SELECT e.*,e.election_date::text date,p.id AS pub_id,p.scope,p.published_at,p.coverage FROM editions e LEFT JOIN publications p ON p.id=e.active_publication_id AND p.status='published' WHERE ($1::text IS NULL OR country=$1) AND ($2::int IS NULL OR year=$2) AND ($3::int IS NULL OR round=$3) ORDER BY country,year DESC,round`,
    [query.country, query.year, query.round],
  )
  return {
    items: rows.rows.map((r) => ({
      id: r.id,
      country: r.country,
      year: r.year,
      round: r.round,
      electionDate: r.date,
      publication: r.pub_id ? publication({ ...r, id: r.pub_id }) : null,
    })),
  }
}
/**
 * The edition with its publication: an explicitly requested publication must be published, while
 * an edition without an active publication is listed with `publication: null`, as in the list.
 */
export async function edition(client: pg.PoolClient, id: string, requested?: string) {
  const row = (
    await client.query('SELECT *,election_date::text date FROM editions WHERE id=$1', [id])
  ).rows[0]
  if (!row) throw new ApiError(404, 'ELECTION_NOT_FOUND', 'Election not found')
  const selected = requested ?? row.active_publication_id
  const pub = selected
    ? (
        await client.query(
          "SELECT * FROM publications WHERE edition_id=$1 AND id=$2 AND status='published'",
          [id, selected],
        )
      ).rows[0]
    : undefined
  if (requested && !pub)
    throw new ApiError(404, 'PUBLICATION_NOT_FOUND', 'Published data not found for this election')
  return {
    id: row.id,
    country: row.country,
    year: row.year,
    round: row.round,
    electionDate: row.date,
    publication: pub ? publication(pub) : null,
  }
}
export async function electionContext(client: pg.PoolClient, id: string, requested?: string) {
  const edition = (
    await client.query('SELECT id,active_publication_id FROM editions WHERE id=$1', [id])
  ).rows[0]
  if (!edition) throw new ApiError(404, 'ELECTION_NOT_FOUND', 'Election not found')
  const pub = (
    await client.query(
      "SELECT * FROM publications WHERE edition_id=$1 AND id=$2 AND status='published'",
      [id, requested ?? edition.active_publication_id],
    )
  ).rows[0]
  if (!pub)
    throw new ApiError(404, 'PUBLICATION_NOT_FOUND', 'Published data not found for this election')
  return { context: { client, publicationId: pub.id, coverage: pub.coverage } as Context }
}
export async function contestContext(
  client: pg.PoolClient,
  id: string,
  requested?: string,
): Promise<Context & { contest: ContestRow }> {
  if (
    requested &&
    !(
      await client.query("SELECT 1 FROM publications WHERE id=$1 AND status='published'", [
        requested,
      ])
    ).rowCount
  )
    throw new ApiError(404, 'PUBLICATION_NOT_FOUND', 'Requested publication is unavailable')
  const row = (
    await client.query(
      `SELECT c.*,p.id AS pub_id,p.coverage FROM contests c JOIN publications p ON p.id=c.publication_id AND p.status='published' JOIN editions e ON e.id=p.edition_id WHERE c.id=$1 AND ${requested ? 'p.id=$2' : 'p.id=e.active_publication_id'}`,
      [id, ...(requested ? [requested] : [])],
    )
  ).rows[0]
  if (!row)
    throw new ApiError(404, 'CONTEST_NOT_FOUND', 'Contest not found in the selected publication')
  return { client, publicationId: row.pub_id, coverage: row.coverage, contest: row }
}
export function areaDto(a: AreaRow) {
  return {
    id: a.id,
    level: a.level,
    name: a.name,
    uf: a.uf,
    municipalityCode: a.municipality_code,
    zoneCode: a.zone_code,
    sectionCode: a.section_code,
    featureId: a.feature_id || null,
    parentId: a.parent_id,
    principalAreaId: a.principal_area_id,
  }
}
export function contestDto(c: ContestRow) {
  return {
    id: c.id,
    officeCode: c.office_code,
    officeName: c.office_name,
    electionId: c.election_id,
    scopeAreaId: c.scope_area_id,
    seats: c.seats,
    voteType: c.vote_type,
  }
}
function candidateDto(c: CandidateRow, scope: string, present: Presentation) {
  const { partyDisplayName, ...presentation } = present(c)
  return {
    id: c.id,
    officialId: c.official_id,
    number: c.number,
    name: c.name,
    ...presentation,
    party: c.party_number
      ? {
          number: c.party_number,
          abbreviation: c.abbreviation!,
          name: c.party_name!,
          displayName: partyDisplayName,
        }
      : null,
    officialStatus: c.status,
    voteDestination: c.vote_destination,
    officialSelectedFlag: c.elected,
    officialStatusScopeAreaId: scope,
    coalition: c.coalition,
    federation: c.federation,
    runningMates: c.running_mates,
  }
}
function pagination(query: z.output<typeof PageQuery>, total: number) {
  return {
    limit: query.limit,
    offset: query.offset,
    total,
    hasMore: query.offset + query.limit < total,
  }
}
export async function contests(ctx: Context) {
  const rows = await ctx.client.query<ContestRow>(
    'SELECT * FROM contests WHERE publication_id=$1 ORDER BY office_code,scope_area_id,id',
    [ctx.publicationId],
  )
  return {
    publicationId: ctx.publicationId,
    coverage: ctx.coverage,
    items: rows.rows.map(contestDto),
  }
}
export async function getArea(ctx: Context, id: string, applicable = true) {
  const row = (
    await ctx.client.query<AreaRow>('SELECT * FROM areas WHERE publication_id=$1 AND id=$2', [
      ctx.publicationId,
      id,
    ])
  ).rows[0]
  if (!row) throw new ApiError(404, 'AREA_NOT_FOUND', 'Area not found in this publication')
  if (applicable && ctx.contest) {
    const match = await ctx.client.query(
      `WITH RECURSIVE ancestors AS (SELECT id,parent_id FROM areas WHERE publication_id=$1 AND id=$2 UNION ALL SELECT a.id,a.parent_id FROM areas a JOIN ancestors n ON n.parent_id=a.id WHERE a.publication_id=$1) SELECT 1 FROM ancestors WHERE id=$3`,
      [ctx.publicationId, id, ctx.contest.scope_area_id],
    )
    if (!match.rowCount)
      throw new ApiError(400, 'INCOMPATIBLE_AREA', 'Area is outside this contest’s official scope')
  }
  return row
}
export async function areas(ctx: Context, query: z.output<typeof AreaQuery>) {
  if (query.parentId) await getArea(ctx, query.parentId, false)
  const where = `publication_id=$1 AND ($2::text IS NULL OR level=$2) AND ($3::text IS NULL OR parent_id=$3) AND ($4::text IS NULL OR uf=$4) AND ($5::text IS NULL OR municipality_code=$5) AND ($6::text IS NULL OR zone_code=$6) AND ($7::text IS NULL OR position(lower($7) in lower(name))>0)`
  const args = [
    ctx.publicationId,
    query.level,
    query.parentId,
    query.uf,
    query.municipalityCode,
    query.zoneCode,
    query.q,
  ]
  const total = Number(
    (await ctx.client.query(`SELECT count(*) FROM areas WHERE ${where}`, args)).rows[0].count,
  )
  const rows = await ctx.client.query<AreaRow>(
    `SELECT * FROM areas WHERE ${where} ORDER BY id LIMIT $8 OFFSET $9`,
    [...args, query.limit, query.offset],
  )
  return {
    publicationId: ctx.publicationId,
    coverage: ctx.coverage,
    items: rows.rows.map(areaDto),
    pagination: pagination(query, total),
  }
}
export async function getCandidate(ctx: Context & { contest: ContestRow }, id: string) {
  const row = (
    await ctx.client.query<CandidateRow & { contest_id: string }>(
      `${candidateSelect} WHERE c.publication_id=$1 AND c.id=$2`,
      [ctx.publicationId, id],
    )
  ).rows[0]
  if (!row)
    throw new ApiError(404, 'CANDIDATE_NOT_FOUND', 'Candidate not found in this publication')
  if (row.contest_id !== ctx.contest.id)
    throw new ApiError(
      400,
      'INCOMPATIBLE_CANDIDATE',
      'Candidate does not belong to this contest and publication',
    )
  return row
}
export async function candidates(
  ctx: Context & { contest: ContestRow },
  query: z.output<typeof CandidateQuery>,
  present: Presentation,
) {
  const where = `c.publication_id=$1 AND c.contest_id=$2 AND ($3::text IS NULL OR position(lower($3) in lower(c.display_name))>0 OR c.number=$3) AND ($4::text IS NULL OR c.party_number=$4)`
  const args = [ctx.publicationId, ctx.contest.id, query.q, query.partyNumber]
  const total = Number(
    (await ctx.client.query(`SELECT count(*) FROM candidacies c WHERE ${where}`, args)).rows[0]
      .count,
  )
  const rows = await ctx.client.query<CandidateRow>(
    `${candidateSelect} WHERE ${where} ORDER BY c.number,c.id LIMIT $5 OFFSET $6`,
    [...args, query.limit, query.offset],
  )
  return {
    publicationId: ctx.publicationId,
    items: rows.rows.map((c) => candidateDto(c, ctx.contest.scope_area_id, present)),
    pagination: pagination(query, total),
  }
}
async function resultRows(ctx: Context & { contest: ContestRow }, area: AreaRow) {
  const actual = area.principal_area_id ?? area.id
  const direct = (
    await ctx.client.query<ResultRow>(
      'SELECT * FROM area_results WHERE publication_id=$1 AND contest_id=$2 AND area_id=$3',
      [ctx.publicationId, ctx.contest.id, actual],
    )
  ).rows[0]
  if (direct) return { result: direct, areaIds: [actual] }
  if (area.level !== 'region' || ctx.contest.office_code !== '1')
    return { result: null, areaIds: [] }
  const rows = await ctx.client.query<ResultRow>(
    `SELECT r.* FROM area_results r JOIN areas a ON a.publication_id=r.publication_id AND a.id=r.area_id WHERE r.publication_id=$1 AND r.contest_id=$2 AND a.parent_id=$3 AND a.level='state' AND a.uf!='zz' AND r.source_kind='EA20' ORDER BY a.id`,
    [ctx.publicationId, ctx.contest.id, area.id],
  )
  if (!rows.rowCount) return { result: null, areaIds: [] }
  const expected = Number(
    (
      await ctx.client.query(
        "SELECT count(*) FROM areas WHERE publication_id=$1 AND parent_id=$2 AND level='state' AND uf!='zz'",
        [ctx.publicationId, area.id],
      )
    ).rows[0].count,
  )
  const summed = Object.fromEntries(
    resultColumns.map((key) => [
      key,
      rows.rows.every((r) => r[key as keyof ResultRow] !== null)
        ? String(rows.rows.reduce((n, r) => n + integer(r[key as keyof ResultRow])!, 0))
        : null,
    ]),
  )
  const complete = rows.rows.length === expected && rows.rows.every((r) => r.complete)
  return {
    result: {
      ...rows.rows[0],
      ...summed,
      area_id: area.id,
      source_kind: 'aggregate' as const,
      source_ids: rows.rows.map((r) => r.source_id!),
      status: complete ? 'complete-region' : 'partial-region',
      complete,
      metadata: {
        meaning: `Sum of disjoint domestic UF EA20 results (${rows.rows.length}/${expected} states); exterior excluded`,
      },
    },
    areaIds: rows.rows.map((r) => r.area_id),
  }
}
function totals(r: ResultRow) {
  return {
    eligible: integer(r.eligible),
    turnout: integer(r.turnout),
    abstentions: integer(r.abstentions),
    totalVotes: integer(r.total_votes),
    validVotes: integer(r.valid_votes),
    nominalVotes: integer(r.nominal_votes),
    legendVotes: integer(r.legend_votes),
    blankVotes: integer(r.blank_votes),
    nullVotes: integer(r.null_votes),
    sectionsTotal: integer(r.sections_total),
    sectionsCounted: integer(r.sections_counted),
  }
}
const basis = (r: ResultRow) =>
  r.source_kind === 'BU' ? 'printedNominalVotes' : 'recordedCandidateVotesSum'
async function voteSummary(
  ctx: Context & { contest: ContestRow },
  r: ResultRow,
  areaIds: string[],
) {
  const stats = (
    await ctx.client.query(
      `SELECT coalesce(sum(votes),0)::text sum,count(*)::int count FROM candidate_results WHERE publication_id=$1 AND contest_id=$2 AND area_id=ANY($3::text[])`,
      [ctx.publicationId, ctx.contest.id, areaIds],
    )
  ).rows[0]
  const groups = (
    await ctx.client.query(
      `SELECT votes::text,array_agg(candidate_id ORDER BY candidate_id) ids FROM (SELECT candidate_id,sum(votes) votes FROM candidate_results WHERE publication_id=$1 AND contest_id=$2 AND area_id=ANY($3::text[]) GROUP BY candidate_id) c GROUP BY c.votes ORDER BY c.votes DESC LIMIT 3`,
      [ctx.publicationId, ctx.contest.id, areaIds],
    )
  ).rows
  const denominator = r.source_kind === 'BU' ? integer(r.nominal_votes) : integer(stats.sum)
  const first = groups[0]
  const second = groups[1]
  const tied = first?.ids.length > 1
  const margin =
    first && (tied || second) ? (tied ? 0 : integer(first.votes)! - integer(second.votes)!) : null
  let cutoff: number | null = null
  if (ctx.contest.office_code === '5' && ctx.contest.seats === 2) {
    const ordered = groups.flatMap((g) => g.ids.map(() => integer(g.votes)!))
    if (ordered.length >= 3) cutoff = ordered[1] - ordered[2]
  }
  return {
    leaders: first?.ids ?? [],
    tie: !!tied,
    candidateVoteDenominator: denominator,
    shareBasis: basis(r),
    turnout: measure(integer(r.turnout), integer(r.eligible), 'eligibleElectors'),
    margin: { votes: margin, percentagePoints: percentage(margin, denominator), basis: basis(r) },
    seatCutoffMargin:
      ctx.contest.office_code === '5' && ctx.contest.seats === 2
        ? { votes: cutoff, percentagePoints: percentage(cutoff, denominator), basis: basis(r) }
        : null,
  }
}
export async function results(
  ctx: Context & { contest: ContestRow },
  areaId: string,
  query: z.output<typeof PageQuery>,
  present: Presentation,
) {
  const area = await getArea(ctx, areaId)
  const { result: r, areaIds } = await resultRows(ctx, area)
  const base = {
    publicationId: ctx.publicationId,
    coverage: ctx.coverage,
    contest: contestDto(ctx.contest),
    area: areaDto(area),
    resultAreaId: area.principal_area_id ?? area.id,
  }
  if (!r)
    return {
      ...base,
      state: 'unavailable',
      complete: false,
      officialStatus: null,
      totals: null,
      provenance: null,
      summary: null,
      candidates: [],
      pagination: pagination(query, 0),
      parties: [],
      unresolvedVotables: [],
    }
  const summary = await voteSummary(ctx, r, areaIds)
  const voting = `WITH voting AS (SELECT candidate_id,sum(votes)::text votes,CASE WHEN count(*)=1 THEN max(official_percentage) END official_percentage,CASE WHEN count(DISTINCT vote_destination)=1 THEN max(vote_destination) END destination FROM candidate_results WHERE publication_id=$1 AND contest_id=$2 AND area_id=ANY($3::text[]) GROUP BY candidate_id)`
  const total = Number(
    (
      await ctx.client.query(`${voting} SELECT count(*) FROM voting`, [
        ctx.publicationId,
        ctx.contest.id,
        areaIds,
      ])
    ).rows[0].count,
  )
  const rows = (
    await ctx.client.query(
      `${voting} SELECT c.*,p.abbreviation,p.name party_name,v.votes,v.official_percentage,v.destination FROM voting v JOIN candidacies c ON c.id=v.candidate_id AND c.publication_id=$1 AND c.contest_id=$2 LEFT JOIN parties p ON p.publication_id=c.publication_id AND p.number=c.party_number ORDER BY v.votes::bigint DESC,c.id LIMIT $4 OFFSET $5`,
      [ctx.publicationId, ctx.contest.id, areaIds, query.limit, query.offset],
    )
  ).rows
  const parties = (
    await ctx.client.query(
      `SELECT party_number,${['nominal_votes', 'valid_nominal_votes', 'legend_votes', 'valid_legend_votes'].map((k) => `CASE WHEN count(${k})=count(*) THEN sum(${k})::text END ${k}`).join(',')} FROM party_results WHERE publication_id=$1 AND contest_id=$2 AND area_id=ANY($3::text[]) GROUP BY party_number ORDER BY party_number`,
      [ctx.publicationId, ctx.contest.id, areaIds],
    )
  ).rows
  const unresolved =
    r.source_kind === 'BU'
      ? (
          await ctx.client.query(
            `SELECT v.* FROM votable_results v WHERE v.publication_id=$1 AND v.contest_id=$2 AND v.area_id=$3 AND v.vote_type='1' AND NOT EXISTS(SELECT 1 FROM candidacies c JOIN candidate_results cr ON cr.publication_id=c.publication_id AND cr.contest_id=c.contest_id AND cr.candidate_id=c.id WHERE c.publication_id=v.publication_id AND c.contest_id=v.contest_id AND c.number=v.number AND cr.area_id=v.area_id) ORDER BY v.number`,
            [ctx.publicationId, ctx.contest.id, r.area_id],
          )
        ).rows
      : []
  if (unresolved.length) {
    summary.leaders = []
    summary.tie = false
    summary.margin = {
      votes: null,
      percentagePoints: null,
      basis: 'unresolvedPrintedCandidateVotes',
    }
    summary.seatCutoffMargin = null
  }
  return {
    ...base,
    state: area.principal_area_id ? 'shared' : 'available',
    complete: r.complete,
    officialStatus: r.status,
    totals: totals(r),
    provenance: {
      sourceKind: r.source_kind,
      sourceIds: r.source_ids ?? [r.source_id!],
      meaning:
        r.metadata.meaning ??
        (r.source_kind === 'BU'
          ? 'Printed ballot votes; judicial destination unavailable'
          : 'Official judicial totalization; candidate recorded votes retain their destination'),
      generatedAt: r.metadata.generatedAt ?? r.metadata.emittedAt ?? null,
    },
    summary,
    candidates: rows.map((c) => ({
      candidate: candidateDto(c, ctx.contest.scope_area_id, present),
      votes: integer(c.votes),
      share: measure(integer(c.votes), summary.candidateVoteDenominator, basis(r)),
      officialPercentage:
        r.source_kind === 'EA20' && c.official_percentage !== null
          ? {
              value: Number(c.official_percentage),
              basis:
                r.metadata.officialPercentageBasis ??
                'TSE pvapn (official competing-candidate basis)',
            }
          : null,
      voteDestination: c.destination,
    })),
    pagination: pagination(query, total),
    parties: parties.map((p) => ({
      partyNumber: p.party_number,
      nominalVotes: integer(p.nominal_votes),
      validNominalVotes: integer(p.valid_nominal_votes),
      legendVotes: integer(p.legend_votes),
      validLegendVotes: integer(p.valid_legend_votes),
    })),
    unresolvedVotables: unresolved.map((v) => ({
      number: v.number,
      voteType: v.vote_type,
      partyNumber: v.party_number,
      votes: integer(v.votes)!,
    })),
  }
}
// Canonical order from country to section; every parent sits at a higher level than its children.
const levels: readonly string[] = Level.options
// Navigation depth: regions only group states, so they share the country's depth.
const steps = levels.filter((level) => level !== 'region')
const depth = (level: string) => steps.indexOf(level === 'region' ? 'country' : level)
async function territory(
  ctx: Context & { contest: ContestRow },
  scope: AreaRow,
  level: string,
  limit: number,
  offset: number,
  candidateId?: string,
) {
  // Only areas above the requested level can contain it, so the recursion stops expanding there.
  const descendants = `WITH RECURSIVE descendants AS (SELECT * FROM areas WHERE publication_id=$1 AND id=$2 UNION ALL SELECT a.* FROM areas a JOIN descendants d ON a.parent_id=d.id WHERE a.publication_id=$1 AND d.level=ANY($3::text[]))`
  const args = [ctx.publicationId, scope.id, levels.slice(0, levels.indexOf(level)), level]
  const total = Number(
    (await ctx.client.query(`${descendants} SELECT count(*) FROM descendants WHERE level=$4`, args))
      .rows[0].count,
  )
  // Rankings and vote sums are computed area by area, only for the requested page; the lateral
  // form keeps that work linear even when the planner misestimates the recursive row count.
  const rows = (
    await ctx.client.query(
      `${descendants}, page AS (SELECT * FROM descendants WHERE level=$4 ORDER BY id LIMIT $5 OFFSET $6) SELECT a.*,r.source_kind,r.complete,r.metadata,r.nominal_votes,r.turnout,r.eligible,s.vote_sum,s.leaders,s.first_votes,s.second_votes,v.votes::text candidate_votes FROM page a LEFT JOIN area_results r ON r.publication_id=a.publication_id AND r.contest_id=$7 AND r.area_id=coalesce(a.principal_area_id,a.id) LEFT JOIN LATERAL (SELECT sum(votes)::text vote_sum,array_agg(candidate_id ORDER BY candidate_id) FILTER(WHERE votes=max_votes) leaders,(array_agg(votes ORDER BY votes DESC))[1]::text first_votes,(array_agg(votes ORDER BY votes DESC))[2]::text second_votes FROM (SELECT candidate_id,votes,max(votes) OVER() max_votes FROM candidate_results WHERE publication_id=$1 AND contest_id=$7 AND area_id=r.area_id) ranked) s ON true LEFT JOIN candidate_results v ON v.publication_id=a.publication_id AND v.contest_id=$7 AND v.area_id=r.area_id AND v.candidate_id=$8 ORDER BY a.id`,
      [...args, limit, offset, ctx.contest.id, candidateId],
    )
  ).rows
  return { rows, total }
}
async function scopeVotes(
  ctx: Context & { contest: ContestRow },
  scope: AreaRow,
  candidateId: string,
) {
  const { result: r, areaIds } = await resultRows(ctx, scope)
  const row = (
    await ctx.client.query(
      'SELECT sum(votes)::text votes FROM candidate_results WHERE publication_id=$1 AND contest_id=$2 AND area_id=ANY($3::text[]) AND candidate_id=$4',
      [ctx.publicationId, ctx.contest.id, areaIds, candidateId],
    )
  ).rows[0]
  return {
    votes: integer(row.votes),
    sourceKind: r?.source_kind === 'aggregate' ? 'EA20' : r?.source_kind,
    complete: r?.complete ?? false,
  }
}
function territorialItem(
  row: Record<string, unknown> & AreaRow,
  parentVotes: { votes: number | null; sourceKind?: string },
) {
  const shared = row.principal_area_id !== null
  const metadata = row.metadata as ResultRow['metadata'] | null
  const votes = shared
    ? null
    : (integer(row.candidate_votes) ??
      (row.complete && metadata?.candidateOmissionMeansZero ? 0 : null))
  const denominator = row.source_kind === 'BU' ? integer(row.nominal_votes) : integer(row.vote_sum)
  return {
    area: areaDto(row),
    state: shared ? 'shared' : row.source_kind ? 'available' : 'unavailable',
    complete: !!row.complete,
    sourceKind: row.source_kind ?? null,
    votes,
    support: measure(
      votes,
      denominator,
      row.source_kind === 'BU' ? 'printedNominalVotes' : 'recordedCandidateVotesSum',
    ),
    contribution: measure(
      row.source_kind === parentVotes.sourceKind ? votes : null,
      parentVotes.votes,
      row.source_kind === parentVotes.sourceKind
        ? 'candidateVotesInSelectedScope'
        : 'incompatibleOrUnavailableSourceBases',
    ),
  }
}
export async function distribution(
  ctx: Context & { contest: ContestRow },
  query: z.output<typeof DistributionQuery>,
) {
  await getCandidate(ctx, query.candidateId)
  const scope = await getArea(ctx, query.areaId ?? ctx.contest.scope_area_id)
  // Areas at or above the selected area's level cannot lie inside it.
  if (levels.indexOf(query.level) <= levels.indexOf(scope.level))
    throw new ApiError(
      400,
      'LEVEL_NOT_BELOW_SCOPE',
      'Select a level below the area (country, region, state, municipality, zone, section)',
    )
  // A level more than two navigation steps below the area (e.g. every section of a state) is
  // refused instead of enumerating hundreds of thousands of areas for each page.
  if (depth(query.level) - depth(scope.level) > 2)
    throw new ApiError(400, 'LEVEL_TOO_DEEP', 'Select a level at most two levels below the area')
  const parentVotes = await scopeVotes(ctx, scope, query.candidateId)
  const { rows, total } = await territory(
    ctx,
    scope,
    query.level,
    query.limit,
    query.offset,
    query.candidateId,
  )
  return {
    publicationId: ctx.publicationId,
    coverage: ctx.coverage,
    contestId: ctx.contest.id,
    candidateId: query.candidateId,
    scopeAreaId: scope.id,
    items: rows.map((r) => territorialItem(r, parentVotes)),
    pagination: pagination(query, total),
  }
}
export async function map(
  ctx: Context & { contest: ContestRow },
  query: z.output<typeof MapQuery>,
) {
  if (
    ['candidateVotes', 'candidateShare', 'contribution'].includes(query.metric) &&
    !query.candidateId
  )
    throw new ApiError(400, 'CANDIDATE_REQUIRED', 'This metric requires candidateId')
  if (query.candidateId) await getCandidate(ctx, query.candidateId)
  const scope = await getArea(ctx, query.areaId ?? ctx.contest.scope_area_id)
  const parentVotes = query.candidateId
    ? await scopeVotes(ctx, scope, query.candidateId)
    : { votes: null, sourceKind: undefined }
  const { rows, total } = await territory(ctx, scope, query.level, 10_000, 0, query.candidateId)
  if (total > 10_000) throw new ApiError(400, 'MAP_SCOPE_TOO_LARGE', 'Select a smaller map scope')
  const items = rows
    .filter((r) => Boolean(r.feature_id))
    .map((r) => {
      const item = territorialItem(r, parentVotes)
      const leaders: string[] = r.leaders ?? []
      const denominator = r.source_kind === 'BU' ? integer(r.nominal_votes) : integer(r.vote_sum)
      const margin =
        r.first_votes !== null && r.second_votes !== null
          ? integer(r.first_votes)! - integer(r.second_votes)!
          : null
      const metric =
        query.metric === 'candidateVotes'
          ? {
              value: item.votes,
              basis: r.source_kind === 'BU' ? 'printedCandidateVotes' : 'recordedCandidateVotes',
            }
          : query.metric === 'candidateShare'
            ? item.support
            : query.metric === 'contribution'
              ? item.contribution
              : query.metric === 'turnout'
                ? measure(integer(r.turnout), integer(r.eligible), 'eligibleElectors')
                : query.metric === 'margin'
                  ? { value: percentage(margin, denominator), basis: item.support.basis }
                  : { value: integer(r.first_votes), basis: item.support.basis }
      return {
        areaId: r.id,
        featureId: r.feature_id,
        value: metric.value,
        state: item.state,
        sourceKind: item.sourceKind,
        basis: metric.basis,
        leaders,
        tie: leaders.length > 1,
        complete: item.complete,
      }
    })
  return {
    publicationId: ctx.publicationId,
    coverage: ctx.coverage,
    contestId: ctx.contest.id,
    scopeAreaId: scope.id,
    level: query.level,
    metric: query.metric,
    candidateId: query.candidateId ?? null,
    items,
    omittedWithoutGeometry: rows.filter((r) => !r.feature_id).length,
    missingResults: rows.filter((r) => !r.source_kind).length,
  }
}
export async function source(client: pg.PoolClient, id: string, requested?: string) {
  const row = (
    await client.query(
      `SELECT s.id,s.publication_id,s.url,s.sha256,s.kind,s.generated_at,s.collected_at FROM source_documents s JOIN publications p ON p.id=s.publication_id AND p.status='published' WHERE s.id=$1 AND ($2::uuid IS NULL OR p.id=$2)`,
      [id, requested],
    )
  ).rows[0]
  if (!row) throw new ApiError(404, 'SOURCE_NOT_FOUND', 'Source not found in a published dataset')
  return {
    id: row.id,
    publicationId: row.publication_id,
    url: row.url,
    sha256: row.sha256,
    kind: row.kind,
    generatedAt: row.generated_at,
    collectedAt: row.collected_at.toISOString(),
    meaning:
      row.kind === 'BU'
        ? 'Original printed ballot bulletin; judicial destination unavailable'
        : 'Original official TSE source document',
  }
}
