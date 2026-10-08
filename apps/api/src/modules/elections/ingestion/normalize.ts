import type pg from 'pg'
import { decodeBu } from './bu.js'
import type { Source } from './source.js'
import type { UnifiedResult } from './types.js'
import { contestId, count } from './types.js'

export async function normalizeUnified(
  client: pg.PoolClient,
  pub: string,
  source: Source,
  data: UnifiedResult,
  context: { contestId: string; areaId: string; electionId: string; officeCode: string },
) {
  if (
    data.ele !== context.electionId ||
    data.t !== '1' ||
    data.carg.length !== 1 ||
    data.carg[0]?.cd !== context.officeCode
  )
    throw new Error(`Unexpected EA20 contest: ${source.url}`)
  const segments = context.areaId.split(':')
  const expected =
    context.areaId === 'br'
      ? ['br', 'br']
      : segments.length === 1
        ? ['uf', context.areaId === 'exterior' ? 'zz' : context.areaId]
        : segments.length === 2
          ? ['mu', segments[1]]
          : ['zona', segments[2]]
  if (data.tpabr !== expected[0] || data.cdabr !== expected[1])
    throw new Error(`EA20 area does not match inventory: ${source.url}`)
  const cargo = data.carg[0]
  await client.query('UPDATE contests SET seats=$3 WHERE publication_id=$1 AND id=$2', [
    pub,
    context.contestId,
    count(cargo.nv),
  ])
  await client.query(
    'DELETE FROM area_results WHERE publication_id=$1 AND contest_id=$2 AND area_id=$3',
    [pub, context.contestId, context.areaId],
  )
  await client.query(
    `INSERT INTO area_results(publication_id,contest_id,area_id,source_id,source_kind,status,complete,
 eligible,turnout,abstentions,total_votes,valid_votes,nominal_votes,legend_votes,blank_votes,null_votes,sections_total,sections_counted,metadata)
 VALUES($1,$2,$3,$4,'EA20',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      pub,
      context.contestId,
      context.areaId,
      source.id,
      data.and,
      data.tf === 's',
      count(data.e.te),
      count(data.e.c),
      count(data.e.a),
      count(data.v.tv),
      count(data.v.vv),
      count(data.v.vnom),
      count(data.v.vl),
      count(data.v.vb),
      count(data.v.tvn),
      count(data.s.ts),
      count(data.s.st),
      {
        sectionTotals: data.s,
        electorTotals: data.e,
        voteTotals: data.v,
        generatedAt: `${data.dg} ${data.hg}`,
        candidateOmissionMeansZero: false,
        officialPercentageBasis: 'TSE pvapn (official competing-candidate basis)',
      },
    ],
  )
  // Rows are written per table in one statement each, with the semantics of row-by-row writes:
  // the last party upsert wins, the first candidacy wins, and duplicate results still fail.
  const parties = new Map<string, [string, string]>()
  const partyResults = columns(5)
  const candidacies = new Map<string, unknown[]>()
  const candidateResults = columns(4)
  for (const group of cargo.agr)
    for (const party of group.par) {
      parties.set(party.n, [party.sg, party.nm])
      push(partyResults, [
        party.n,
        count(party.tvtn),
        count(party.tvan),
        count(party.tvtl),
        count(party.tval),
      ])
      for (const candidate of party.cand ?? []) {
        const id = `${context.contestId}:${candidate.sqcand}`
        if (!candidacies.has(id))
          candidacies.set(id, [
            id,
            candidate.sqcand,
            candidate.n,
            candidate.nm,
            candidate.nmu,
            party.n,
            candidate.st ?? null,
            candidate.dvt ?? null,
            candidate.e === undefined ? null : candidate.e === 's',
            JSON.stringify({
              number: group.n,
              name: group.nm,
              type: group.tp,
              composition: group.com,
            }),
            json(cargo.fed?.find((f) => f.n === party.nfed) ?? null),
            JSON.stringify(candidate.vs ?? []),
          ])
        if (candidate.vap !== undefined)
          push(candidateResults, [
            id,
            count(candidate.vap),
            candidate.pvapn?.replace(',', '.') ?? null,
            candidate.dvt ?? null,
          ])
      }
    }
  if (parties.size)
    await client.query(
      `INSERT INTO parties(publication_id,number,abbreviation,name)
   SELECT $1,* FROM unnest($2::text[],$3::text[],$4::text[])
   ON CONFLICT(publication_id,number) DO UPDATE SET abbreviation=excluded.abbreviation,name=excluded.name`,
      [pub, [...parties.keys()], ...transpose([...parties.values()], 2)],
    )
  if (partyResults[0]!.length)
    await client.query(
      `INSERT INTO party_results(publication_id,contest_id,area_id,party_number,nominal_votes,valid_nominal_votes,legend_votes,valid_legend_votes)
   SELECT $1,$2,$3,* FROM unnest($4::text[],$5::bigint[],$6::bigint[],$7::bigint[],$8::bigint[])`,
      [pub, context.contestId, context.areaId, ...partyResults],
    )
  if (candidacies.size)
    await client.query(
      `INSERT INTO candidacies(publication_id,contest_id,id,official_id,number,name,display_name,party_number,status,vote_destination,elected,coalition,federation,running_mates)
   SELECT $1,$2,id,official,number,name,display,party,status,destination,elected,coalition::jsonb,federation::jsonb,mates::jsonb
   FROM unnest($3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::text[],$10::text[],$11::boolean[],$12::text[],$13::text[],$14::text[])
   AS t(id,official,number,name,display,party,status,destination,elected,coalition,federation,mates)
   ON CONFLICT(publication_id,contest_id,id) DO NOTHING`,
      [pub, context.contestId, ...transpose([...candidacies.values()], 12)],
    )
  if (candidateResults[0]!.length)
    await client.query(
      `INSERT INTO candidate_results(publication_id,contest_id,area_id,candidate_id,votes,official_percentage,vote_destination)
   SELECT $1,$2,$3,* FROM unnest($4::text[],$5::bigint[],$6::numeric[],$7::text[])`,
      [pub, context.contestId, context.areaId, ...candidateResults],
    )
}

/**
 * Contest, candidacy and party lookups for bulletins, loaded once per contest. Reusable for an
 * import invocation because every EA20 unit, which writes candidacies and parties, is normalized
 * before any section bulletin.
 */
export class BulletinCatalog {
  private readonly contests = new Map<string, Map<string, string | null>>()
  private parties?: Set<string>
  constructor(
    private readonly client: pg.PoolClient,
    private readonly pub: string,
  ) {}
  /** Candidacy ID by ballot number; null when the number is ambiguous within the contest. */
  async candidacies(contest: string) {
    let numbers = this.contests.get(contest)
    if (numbers) return numbers
    const applicable = await this.client.query(
      'SELECT 1 FROM contests WHERE publication_id=$1 AND id=$2',
      [this.pub, contest],
    )
    if (!applicable.rowCount) throw new Error(`Unknown BU contest ${contest}`)
    numbers = new Map()
    const rows = await this.client.query(
      'SELECT id,number FROM candidacies WHERE publication_id=$1 AND contest_id=$2',
      [this.pub, contest],
    )
    for (const row of rows.rows) numbers.set(row.number, numbers.has(row.number) ? null : row.id)
    this.contests.set(contest, numbers)
    return numbers
  }
  async party(number: string) {
    this.parties ??= new Set(
      (
        await this.client.query('SELECT number FROM parties WHERE publication_id=$1', [this.pub])
      ).rows.map((row) => row.number as string),
    )
    return this.parties.has(number)
  }
}

export async function normalizeBulletin(
  client: pg.PoolClient,
  pub: string,
  source: Source,
  context: { uf: string; municipality: string; zone: string; section: string; areaId: string },
  catalog = new BulletinCatalog(client, pub),
) {
  const bulletin = decodeBu(source.bytes)
  if (
    bulletin.municipality !== context.municipality ||
    bulletin.zone !== context.zone ||
    bulletin.section !== context.section
  )
    throw new Error('BU identity does not match inventory')
  const areas = columns(10)
  const votables = columns(5)
  const candidates = columns(3)
  const parties = columns(4)
  for (const election of bulletin.elections)
    for (const office of election.offices) {
      const scope =
        office.officeCode === '1'
          ? 'br'
          : office.officeCode === '25'
            ? `${context.uf}:${context.municipality}`
            : context.uf
      const contest = contestId(election.electionId, office.officeCode, scope)
      if (areas[0]!.includes(contest)) throw new Error(`Duplicate BU contest ${contest}`)
      const numbers = await catalog.candidacies(contest)
      const totals = (type: number) =>
        office.votes.filter((v) => v.type === type).reduce((n, v) => n + v.votes, 0)
      const legend = [6, 7, 8].includes(Number(office.officeCode))
      // Printed BU votes precede judicial destination. Valid totals remain unknown here.
      push(areas, [
        contest,
        election.eligible,
        office.turnout,
        election.eligible - office.turnout,
        office.votes.reduce((n, v) => n + v.votes, 0),
        totals(1),
        legend ? totals(4) : null,
        totals(2),
        totals(3),
        JSON.stringify({
          emittedAt: bulletin.emittedAt,
          eligibleOriginal: election.eligibleOriginal,
          eligibleTemporary: election.eligibleTemporary,
          voteBasis: 'printed BU votes; judicial destination unavailable',
          candidateOmissionMeansZero: false,
        }),
      ])
      for (const vote of office.votes) {
        push(votables, [contest, vote.number ?? '', String(vote.type), vote.party, vote.votes])
        // Reused ballot numbers after substitutions are ambiguous; retain the votable instead.
        const candidate = vote.type === 1 && vote.number !== null ? numbers.get(vote.number) : null
        if (candidate) push(candidates, [contest, candidate, vote.votes])
      }
      const partyNumbers = [
        ...new Set(office.votes.filter((v) => v.party !== null).map((v) => v.party!)),
      ]
      for (const party of partyNumbers)
        if (await catalog.party(party))
          push(parties, [
            contest,
            party,
            office.votes
              .filter((v) => v.party === party && v.type === 1)
              .reduce((n, v) => n + v.votes, 0),
            legend
              ? office.votes
                  .filter((v) => v.party === party && v.type === 4)
                  .reduce((n, v) => n + v.votes, 0)
              : null,
          ])
    }
  if (!areas[0]!.length) return
  await client.query(
    'DELETE FROM area_results WHERE publication_id=$1 AND area_id=$2 AND contest_id=ANY($3::text[])',
    [pub, context.areaId, areas[0]],
  )
  await client.query(
    `INSERT INTO area_results(publication_id,contest_id,area_id,source_id,source_kind,status,complete,
   eligible,turnout,abstentions,total_votes,nominal_votes,legend_votes,blank_votes,null_votes,sections_total,sections_counted,metadata)
   SELECT $1,contest,$2,$3,'BU','printed',true,eligible,turnout,abstentions,total,nominal,legend,blank,null_votes,1,1,metadata::jsonb
   FROM unnest($4::text[],$5::bigint[],$6::bigint[],$7::bigint[],$8::bigint[],$9::bigint[],$10::bigint[],$11::bigint[],$12::bigint[],$13::text[])
   AS t(contest,eligible,turnout,abstentions,total,nominal,legend,blank,null_votes,metadata)`,
    [pub, context.areaId, source.id, ...areas],
  )
  if (votables[0]!.length)
    await client.query(
      `INSERT INTO votable_results(publication_id,contest_id,area_id,number,vote_type,party_number,votes)
   SELECT $1,contest,$2,number,type,party,votes FROM unnest($3::text[],$4::text[],$5::text[],$6::text[],$7::bigint[])
   AS t(contest,number,type,party,votes)`,
      [pub, context.areaId, ...votables],
    )
  if (candidates[0]!.length)
    await client.query(
      `INSERT INTO candidate_results(publication_id,contest_id,area_id,candidate_id,votes)
   SELECT $1,contest,$2,candidate,votes FROM unnest($3::text[],$4::text[],$5::bigint[]) AS t(contest,candidate,votes)`,
      [pub, context.areaId, ...candidates],
    )
  if (parties[0]!.length)
    await client.query(
      `INSERT INTO party_results(publication_id,contest_id,area_id,party_number,nominal_votes,legend_votes)
   SELECT $1,contest,$2,party,nominal,legend FROM unnest($3::text[],$4::text[],$5::bigint[],$6::bigint[])
   AS t(contest,party,nominal,legend)`,
      [pub, context.areaId, ...parties],
    )
}

function columns(width: number): unknown[][] {
  return Array.from({ length: width }, () => [])
}
function push(target: unknown[][], row: unknown[]) {
  row.forEach((value, index) => target[index]!.push(value))
}
function transpose(rows: unknown[][], width: number) {
  const result = columns(width)
  for (const row of rows) push(result, row)
  return result
}
function json(value: unknown) {
  return value === null || value === undefined ? null : JSON.stringify(value)
}
