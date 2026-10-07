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
  for (const group of cargo.agr)
    for (const party of group.par) {
      await client.query(
        `INSERT INTO parties(publication_id,number,abbreviation,name) VALUES($1,$2,$3,$4)
   ON CONFLICT(publication_id,number) DO UPDATE SET abbreviation=excluded.abbreviation,name=excluded.name`,
        [pub, party.n, party.sg, party.nm],
      )
      await client.query(
        `INSERT INTO party_results(publication_id,contest_id,area_id,party_number,nominal_votes,valid_nominal_votes,legend_votes,valid_legend_votes)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          pub,
          context.contestId,
          context.areaId,
          party.n,
          count(party.tvtn),
          count(party.tvan),
          count(party.tvtl),
          count(party.tval),
        ],
      )
      for (const candidate of party.cand ?? []) {
        const id = `${context.contestId}:${candidate.sqcand}`
        await client.query(
          `INSERT INTO candidacies(publication_id,contest_id,id,official_id,number,name,display_name,party_number,status,vote_destination,elected,coalition,federation,running_mates)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT(publication_id,contest_id,id) DO NOTHING`,
          [
            pub,
            context.contestId,
            id,
            candidate.sqcand,
            candidate.n,
            candidate.nm,
            candidate.nmu,
            party.n,
            candidate.st ?? null,
            candidate.dvt ?? null,
            candidate.e === undefined ? null : candidate.e === 's',
            { number: group.n, name: group.nm, type: group.tp, composition: group.com },
            cargo.fed?.find((f) => f.n === party.nfed) ?? null,
            JSON.stringify(candidate.vs ?? []),
          ],
        )
        if (candidate.vap !== undefined)
          await client.query(
            `INSERT INTO candidate_results(publication_id,contest_id,area_id,candidate_id,votes,official_percentage,vote_destination)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              pub,
              context.contestId,
              context.areaId,
              id,
              count(candidate.vap),
              candidate.pvapn?.replace(',', '.') ?? null,
              candidate.dvt ?? null,
            ],
          )
      }
    }
}

export async function normalizeBulletin(
  client: pg.PoolClient,
  pub: string,
  source: Source,
  context: { uf: string; municipality: string; zone: string; section: string; areaId: string },
) {
  const bulletin = decodeBu(source.bytes)
  if (
    bulletin.municipality !== context.municipality ||
    bulletin.zone !== context.zone ||
    bulletin.section !== context.section
  )
    throw new Error('BU identity does not match inventory')
  for (const election of bulletin.elections)
    for (const office of election.offices) {
      const scope =
        office.officeCode === '1'
          ? 'br'
          : office.officeCode === '25'
            ? `${context.uf}:${context.municipality}`
            : context.uf
      const contest = contestId(election.electionId, office.officeCode, scope)
      const applicable = await client.query(
        'SELECT 1 FROM contests WHERE publication_id=$1 AND id=$2',
        [pub, contest],
      )
      if (!applicable.rowCount) throw new Error(`Unknown BU contest ${contest}`)
      const totals = (type: number) =>
        office.votes.filter((v) => v.type === type).reduce((n, v) => n + v.votes, 0)
      const total = office.votes.reduce((n, v) => n + v.votes, 0)
      // Printed BU votes precede judicial destination. Valid totals remain unknown here.
      await client.query(
        'DELETE FROM area_results WHERE publication_id=$1 AND contest_id=$2 AND area_id=$3',
        [pub, contest, context.areaId],
      )
      await client.query(
        `INSERT INTO area_results(publication_id,contest_id,area_id,source_id,source_kind,status,complete,
   eligible,turnout,abstentions,total_votes,nominal_votes,legend_votes,blank_votes,null_votes,sections_total,sections_counted,metadata)
   VALUES($1,$2,$3,$4,'BU','printed',true,$5,$6,$7,$8,$9,$10,$11,$12,1,1,$13)`,
        [
          pub,
          contest,
          context.areaId,
          source.id,
          election.eligible,
          office.turnout,
          election.eligible - office.turnout,
          total,
          totals(1),
          [6, 7, 8].includes(Number(office.officeCode)) ? totals(4) : null,
          totals(2),
          totals(3),
          {
            emittedAt: bulletin.emittedAt,
            eligibleOriginal: election.eligibleOriginal,
            eligibleTemporary: election.eligibleTemporary,
            voteBasis: 'printed BU votes; judicial destination unavailable',
            candidateOmissionMeansZero: false,
          },
        ],
      )
      for (const vote of office.votes) {
        await client.query(
          `INSERT INTO votable_results(publication_id,contest_id,area_id,number,vote_type,party_number,votes)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            pub,
            contest,
            context.areaId,
            vote.number ?? '',
            String(vote.type),
            vote.party,
            vote.votes,
          ],
        )
        if (vote.type === 1) {
          const candidates = await client.query(
            'SELECT id FROM candidacies WHERE publication_id=$1 AND contest_id=$2 AND number=$3',
            [pub, contest, vote.number],
          )
          // Reused ballot numbers after substitutions are ambiguous; retain the votable instead.
          if (candidates.rowCount === 1)
            await client.query(
              `INSERT INTO candidate_results(publication_id,contest_id,area_id,candidate_id,votes)
     VALUES($1,$2,$3,$4,$5)`,
              [pub, contest, context.areaId, candidates.rows[0].id, vote.votes],
            )
        }
      }
      const partyNumbers = [
        ...new Set(office.votes.filter((v) => v.party !== null).map((v) => v.party!)),
      ]
      for (const party of partyNumbers) {
        const known = await client.query(
          'SELECT 1 FROM parties WHERE publication_id=$1 AND number=$2',
          [pub, party],
        )
        if (known.rowCount)
          await client.query(
            `INSERT INTO party_results(publication_id,contest_id,area_id,party_number,nominal_votes,legend_votes)
    VALUES($1,$2,$3,$4,$5,$6)`,
            [
              pub,
              contest,
              context.areaId,
              party,
              office.votes
                .filter((v) => v.party === party && v.type === 1)
                .reduce((n, v) => n + v.votes, 0),
              [6, 7, 8].includes(Number(office.officeCode))
                ? office.votes
                    .filter((v) => v.party === party && v.type === 4)
                    .reduce((n, v) => n + v.votes, 0)
                : null,
            ],
          )
      }
    }
}
