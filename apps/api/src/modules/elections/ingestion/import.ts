import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { normalizeBulletin, normalizeUnified } from './normalize.js'
import { Archive, BASE } from './source.js'
import type {
  Auxiliary,
  Configuration,
  ImportOptions,
  Municipalities,
  Sections,
  UnifiedResult,
} from './types.js'
import { EDITION, PARSER_VERSION, contestId, regionStates } from './types.js'

type TaskContext = {
  areaId: string
  uf: string
  municipality: string
  zone: string
  section: string
  contestId: string
  electionId: string
  officeCode: string
}
const pad = (value: string, width: number) => value.padStart(width, '0')
export async function importElection(pool: pg.Pool, options: ImportOptions) {
  const pub = options.publicationId ?? randomUUID()
  const client = await pool.connect()
  let started = false
  try {
    // ponytail: one importer per database; shard acquisition only if measured national throughput needs it.
    if (!(await client.query('SELECT pg_try_advisory_lock(202602) AS locked')).rows[0].locked)
      throw new Error('Another election import is running')
    await client.query(
      `INSERT INTO editions(id,country,year,round,election_date) VALUES($1,'BR',2026,1,'2026-10-04') ON CONFLICT DO NOTHING`,
      [EDITION],
    )
    const existing = (await client.query('SELECT * FROM publications WHERE id=$1', [pub])).rows[0]
    if (existing?.status === 'published')
      throw new Error('Published datasets are immutable; start a new publication')
    if (
      existing &&
      (existing.scope !== options.scope || existing.parser_version !== PARSER_VERSION)
    )
      throw new Error('Resume options/parser do not match publication')
    const persisted = {
      ...options,
      publicationId: undefined,
      publish: undefined,
      stopAfter: undefined,
    }
    const run = (
      await client.query('SELECT options FROM import_runs WHERE publication_id=$1', [pub])
    ).rows[0]
    if (
      run &&
      JSON.stringify(run.options) !== JSON.stringify(JSON.parse(JSON.stringify(persisted)))
    ) {
      // PostgreSQL jsonb key ordering differs: compare effective values individually.
      for (const key of [
        'scope',
        'municipalitiesPerUf',
        'sectionsPerUf',
        'archiveDir',
        'refresh',
        'pilotUfs',
      ] as const)
        if (JSON.stringify(run.options[key]) !== JSON.stringify(persisted[key]))
          throw new Error(`Resume option differs: ${key}`)
    }
    await client.query(
      `INSERT INTO publications(id,edition_id,status,scope,parser_version) VALUES($1,$2,'preparing',$3,$4) ON CONFLICT DO NOTHING`,
      [pub, EDITION, options.scope, PARSER_VERSION],
    )
    await client.query(
      `INSERT INTO import_runs(publication_id,state,options) VALUES($1,'running',$2) ON CONFLICT(publication_id) DO UPDATE SET state='running',error=null,updated_at=now()`,
      [pub, persisted],
    )
    started = true
    console.log(`Publication ${pub} (${options.scope})`)
    const archive = new Archive(client, pub, options.archiveDir, options.offline, options.refresh)
    const { data: configuration } = await archive.json<Configuration>(
      `${BASE}/comum/config/ele-c.json`,
      'EA11',
    )
    const poll = configuration.pl.find(
      (p) => p.c === 'ele2026' && p.dt === '04/10/2026' && p.e.some((e) => e.t === '1'),
    )
    if (!poll) throw new Error('Official 2026 first-round poll not found')
    const elections = poll.e.filter((e) => e.t === '1')
    await client.query('BEGIN')
    try {
      await area(client, pub, 'br', 'country', 'Brasil', null, null, null, null, null, null)
      for (const [region] of Object.entries(regionStates))
        await area(
          client,
          pub,
          `region:${region}`,
          'region',
          region,
          null,
          null,
          null,
          null,
          null,
          'br',
        )
      await area(client, pub, 'exterior', 'state', 'Exterior', 'zz', null, null, null, null, 'br')
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    const catalogs = new Map<string, Municipalities>()
    for (const election of elections) {
      const { data } = await archive.json<Municipalities>(
        `${BASE}/ele2026/${election.cd}/config/mun-e${pad(election.cd, 6)}-cm.json`,
        'EA12',
      )
      catalogs.set(election.cd, data)
      await client.query('BEGIN')
      try {
        for (const state of data.abr) {
          const stateId = state.cd === 'zz' ? 'exterior' : state.cd
          const region = Object.entries(regionStates).find(([, ufs]) => ufs.includes(state.cd))?.[0]
          await area(
            client,
            pub,
            stateId,
            'state',
            state.ds,
            state.cd,
            null,
            null,
            null,
            state.cd === 'zz' ? null : (state.mu.find((m) => m.cdi)?.cdi?.slice(0, 2) ?? null),
            region ? `region:${region}` : 'br',
          )
          for (const m of state.mu) {
            const id = `${state.cd}:${m.cd}`
            await area(
              client,
              pub,
              id,
              'municipality',
              m.nm,
              state.cd,
              m.cd,
              null,
              null,
              m.cdi || null,
              stateId,
            )
            for (const z of m.z)
              await area(
                client,
                pub,
                `${id}:${z}`,
                'zone',
                `Zona ${z}`,
                state.cd,
                m.cd,
                z,
                null,
                null,
                id,
              )
          }
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
      for (const office of election.abr.flatMap((a) => a.cp)) {
        for (const state of data.abr) {
          if (office.cd !== '1' && state.cd === 'zz') continue
          if (office.cd === '7' && state.cd === 'df') continue
          if (office.cd === '8' && state.cd !== 'df') continue
          const scopes =
            office.cd === '1'
              ? ['br']
              : office.cd === '25'
                ? state.mu.map((m) => `${state.cd}:${m.cd}`)
                : [state.cd]
          for (const scope of scopes) {
            const id = contestId(election.cd, office.cd, scope)
            await client.query(
              `INSERT INTO contests(publication_id,id,election_id,office_code,office_name,scope_area_id,vote_type)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
              [
                pub,
                id,
                election.cd,
                office.cd,
                office.ds,
                scope,
                office.tp === '2' ? 'proportional' : 'majoritarian',
              ],
            )
            // Candidacy catalog is always populated from the official full contest before local observations.
            const mainUf = office.cd === '1' ? 'br' : state.cd
            const mainPrefix = office.cd === '25' ? `${state.cd}${scope.split(':')[1]}` : mainUf
            await task(
              client,
              pub,
              unifiedUrl(election.cd, office.cd, mainUf, mainPrefix),
              'EA20',
              { contestId: id, areaId: scope, electionId: election.cd, officeCode: office.cd },
            )
          }
          if (office.cd === '1' && state.cd !== 'br')
            await task(
              client,
              pub,
              unifiedUrl(election.cd, office.cd, state.cd, state.cd),
              'EA20',
              {
                contestId: contestId(election.cd, office.cd, 'br'),
                areaId: state.cd === 'zz' ? 'exterior' : state.cd,
                electionId: election.cd,
                officeCode: office.cd,
              },
            )
          const municipalities =
            options.scope === 'pilot' &&
            !(options.pilotUfs ?? ['ac', 'df', 'pe', 'zz']).includes(state.cd)
              ? []
              : selectMunicipalities(state.mu, options, state.cd)
          for (const m of municipalities) {
            const scope =
              office.cd === '1' ? 'br' : office.cd === '25' ? `${state.cd}:${m.cd}` : state.cd
            const common = {
              contestId: contestId(election.cd, office.cd, scope),
              electionId: election.cd,
              officeCode: office.cd,
            }
            await task(
              client,
              pub,
              unifiedUrl(election.cd, office.cd, state.cd, `${state.cd}${m.cd}`),
              'EA20',
              { ...common, areaId: `${state.cd}:${m.cd}` },
            )
            for (const z of m.z)
              await task(
                client,
                pub,
                unifiedUrl(election.cd, office.cd, state.cd, `${state.cd}${m.cd}-z${z}`),
                'EA20',
                { ...common, areaId: `${state.cd}:${m.cd}:${z}` },
              )
          }
        }
      }
    }
    // Build the full section inventory, including identifiable aggregated sections without duplicate votes.
    const sectionStates = [
      ...new Set([...catalogs.values()].flatMap((c) => c.abr.map((a) => a.cd))),
    ]
    for (const uf of sectionStates) {
      if (options.scope === 'pilot' && !(options.pilotUfs ?? ['ac', 'df', 'pe', 'zz']).includes(uf))
        continue
      const { data } = await archive.json<Sections>(
        `${BASE}/ele2026/arquivo-urna/${poll.cd}/config/${uf}/${uf}-p${pad(poll.cd, 6)}-cs.json`,
        'EA16',
      )
      const chosen = new Set(
        [...catalogs.values()].flatMap((c) =>
          c.abr
            .filter((a) => a.cd === uf)
            .flatMap((a) => selectMunicipalities(a.mu, options, uf).map((m) => m.cd)),
        ),
      )
      const sectionCandidates: {
        url: string
        aggregated: boolean
        context: Pick<TaskContext, 'areaId' | 'uf' | 'municipality' | 'zone' | 'section'>
      }[] = []
      for (const state of data.abr)
        for (const m of state.mu) {
          if (options.scope === 'pilot' && !chosen.has(m.cd)) continue
          for (const z of m.zon) {
            await client.query('BEGIN')
            try {
              for (const section of z.sec) {
                const areaId = `${uf}:${m.cd}:${z.cd}:${section.ns}`
                await area(
                  client,
                  pub,
                  areaId,
                  'section',
                  `Seção ${section.ns}`,
                  uf,
                  m.cd,
                  z.cd,
                  section.ns,
                  null,
                  `${uf}:${m.cd}:${z.cd}`,
                  section.nsp ? `${uf}:${m.cd}:${z.cd}:${section.nsp}` : null,
                )
              }
              await client.query('COMMIT')
            } catch (error) {
              await client.query('ROLLBACK')
              throw error
            }
            for (const section of z.sec.filter((s) => !s.nsp)) {
              const stem = `p${pad(poll.cd, 6)}-${uf}-m${m.cd}-z${z.cd}-s${section.ns}`
              sectionCandidates.push({
                url: `${BASE}/ele2026/arquivo-urna/${poll.cd}/dados/${uf}/${m.cd}/${z.cd}/${section.ns}/${stem}-aux.json`,
                aggregated: Boolean(section.nsa?.length),
                context: {
                  areaId: `${uf}:${m.cd}:${z.cd}:${section.ns}`,
                  uf,
                  municipality: m.cd,
                  zone: z.cd,
                  section: section.ns,
                },
              })
            }
          }
        }
      const selected =
        options.scope === 'national' ? sectionCandidates : ([] as typeof sectionCandidates)
      if (options.scope === 'pilot') {
        // Pick across municipalities (including Noronha), with aggregated principals represented.
        const groups = [...chosen].map((m) =>
          sectionCandidates
            .filter((s) => s.context.municipality === m)
            .sort(
              (a, b) =>
                Number(b.aggregated) - Number(a.aggregated) ||
                a.context.areaId.localeCompare(b.context.areaId),
            ),
        )
        for (
          let i = 0;
          selected.length < (options.sectionsPerUf ?? 2) && groups.some((g) => g[i]);
          i++
        )
          for (const group of groups)
            if (group[i] && selected.length < (options.sectionsPerUf ?? 2)) selected.push(group[i]!)
      }
      for (const section of selected) await task(client, pub, section.url, 'EA18', section.context)
    }
    const total = (
      await client.query(
        'SELECT count(*)::integer AS n FROM import_tasks WHERE publication_id=$1',
        [pub],
      )
    ).rows[0].n
    await client.query('UPDATE import_runs SET expected_documents=$2 WHERE publication_id=$1', [
      pub,
      total,
    ])
    let processed = 0
    while (true) {
      const jobs = await client.query(
        `SELECT * FROM import_tasks WHERE publication_id=$1 AND state='pending'
    ORDER BY CASE WHEN kind='EA20' THEN 0 ELSE 1 END, length(context->>'areaId'),url LIMIT 100`,
        [pub],
      )
      if (!jobs.rowCount) break
      for (const job of jobs.rows) {
        if (options.stopAfter !== undefined && processed >= options.stopAfter) {
          await client.query("UPDATE import_runs SET state='paused' WHERE publication_id=$1", [pub])
          return { publicationId: pub, status: 'paused', processed }
        }
        const context = job.context as TaskContext
        const { source, data } = await archive.json<UnifiedResult | Auxiliary>(job.url, job.kind)
        let bulletin: Awaited<ReturnType<Archive['get']>> | undefined
        if (job.kind === 'EA18') {
          const auxiliary = data as Auxiliary
          const hashes = auxiliary.hashes.filter((h) => h.st === 'Totalizado')
          if (hashes.length > 1) throw new Error(`Multiple totalized BU hashes: ${job.url}`)
          const selected = hashes[0]
          const bu = selected?.arq.find((a) => a.tp === 'bu' || a.tp === 'busa')
          if (bu) {
            if (!/^[a-fA-F0-9]+$/.test(selected!.hash) || !/^[\w.-]+$/.test(bu.nm))
              throw new Error('Invalid BU source path')
            bulletin = await archive.get(
              `${job.url.slice(0, job.url.lastIndexOf('/'))}/${selected!.hash}/${bu.nm}`,
              'BU',
            )
          } else if (!['Não instalada', 'Não Instalada'].includes(auxiliary.st))
            throw new Error(
              `Section has no final BU or official noninstallation: ${auxiliary.st} ${job.url}`,
            )
        }
        await client.query('BEGIN')
        try {
          if (job.kind === 'EA20')
            await normalizeUnified(client, pub, source, data as UnifiedResult, context)
          else if (bulletin) await normalizeBulletin(client, pub, bulletin, context)
          await client.query(
            'UPDATE source_documents SET metadata=metadata || $2::jsonb WHERE id=$1',
            [source.id, { normalized: true, officialStatus: (data as Auxiliary).st ?? null }],
          )
          await client.query(
            'UPDATE import_tasks SET state=$3 WHERE publication_id=$1 AND url=$2',
            [pub, job.url, job.kind === 'EA18' && !bulletin ? 'official_absence' : 'complete'],
          )
          await client.query(
            'UPDATE import_runs SET completed_documents=completed_documents+1,updated_at=now() WHERE publication_id=$1',
            [pub],
          )
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
        processed++
        if (processed % 100 === 0) console.log(`Imported ${processed} units in this invocation`)
      }
    }
    const coverage = {
      ...(await validatePublication(client, pub, options.scope)),
      selection:
        options.scope === 'pilot'
          ? {
              ufs: options.pilotUfs ?? ['ac', 'df', 'pe', 'zz'],
              municipalitiesPerUf: options.municipalitiesPerUf ?? 1,
              primarySectionsPerUf: options.sectionsPerUf ?? 2,
            }
          : null,
    }
    await client.query('UPDATE publications SET coverage=$2 WHERE id=$1', [pub, coverage])
    await client.query(
      "UPDATE import_runs SET state='ready',updated_at=now() WHERE publication_id=$1",
      [pub],
    )
    if (options.publish !== false) await publishPublication(client, pub)
    return {
      publicationId: pub,
      status: options.publish === false ? 'ready' : 'published',
      coverage,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (started)
      await client
        .query(
          "UPDATE import_runs SET state='failed',error=$2,updated_at=now() WHERE publication_id=$1",
          [pub, error instanceof Error ? error.message : String(error)],
        )
        .catch(() => {})
    throw error
  } finally {
    await client.query('SELECT pg_advisory_unlock(202602)').catch(() => {})
    client.release()
  }
}
async function area(
  client: pg.PoolClient,
  pub: string,
  id: string,
  level: string,
  name: string,
  uf: string | null,
  municipality: string | null,
  zone: string | null,
  section: string | null,
  feature: string | null,
  parent: string | null,
  principal: string | null = null,
) {
  await client.query(
    `INSERT INTO areas(publication_id,id,level,name,uf,municipality_code,zone_code,section_code,feature_id,parent_id,principal_area_id)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(publication_id,id) DO UPDATE SET feature_id=excluded.feature_id`,
    [pub, id, level, name, uf, municipality, zone, section, feature, parent, principal],
  )
}
async function task(
  client: pg.PoolClient,
  pub: string,
  url: string,
  kind: string,
  context: Partial<TaskContext>,
) {
  await client.query(
    'INSERT INTO import_tasks(publication_id,url,kind,context) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [pub, url, kind, context],
  )
}
function selectMunicipalities<T extends { cd: string }>(
  items: T[],
  options: ImportOptions,
  uf: string,
) {
  if (options.scope === 'national') return items
  const ordered =
    uf === 'ac'
      ? [...items].sort((a, b) => Number(b.cd === '01066') - Number(a.cd === '01066'))
      : items
  return ordered.slice(0, options.municipalitiesPerUf ?? 1)
}
function unifiedUrl(election: string, office: string, uf: string, prefix: string) {
  return `${BASE}/ele2026/${election}/dados/${uf}/${prefix}-c${pad(office, 4)}-e${pad(election, 6)}-u.json`
}
export async function validatePublication(client: pg.PoolClient, pub: string, scope: string) {
  const counts = (
    await client.query(
      `SELECT count(*)::integer AS expected,count(*) FILTER(WHERE state!='pending')::integer AS completed,
  count(*) FILTER(WHERE state='official_absence')::integer AS official_absences FROM import_tasks WHERE publication_id=$1`,
      [pub],
    )
  ).rows[0]
  if (counts.expected !== counts.completed)
    throw new Error('Publication contains pending import units')
  const totals = (
    await client.query(
      `SELECT count(*)::integer AS results,count(*) FILTER(WHERE source_kind='BU')::integer AS bu_results,count(DISTINCT source_id) FILTER(WHERE source_kind='BU')::integer AS bu_files,
  count(*) FILTER(WHERE source_kind='EA20')::integer AS aggregates FROM area_results WHERE publication_id=$1`,
      [pub],
    )
  ).rows[0]
  if (!totals.bu_results || !totals.aggregates)
    throw new Error('Publication needs both BU and EA20 results')
  // Only fully covered zones can be reconciled. EA20 judicial destinations differ from printed BU,
  // so compare total ballots, never silently relabel nominal BU counts as valid candidate votes.
  const reconciled = (
    await client.query(
      `WITH section_counts AS (
   SELECT parent_id,count(*) FILTER(WHERE principal_area_id IS NULL)::integer n FROM areas WHERE publication_id=$1 AND level='section' GROUP BY parent_id
  ), printed AS (
   SELECT r.contest_id,a.parent_id,sum(r.total_votes) votes,count(*)::integer n FROM area_results r JOIN areas a USING(publication_id)
   WHERE r.publication_id=$1 AND r.source_kind='BU' AND a.id=r.area_id GROUP BY r.contest_id,a.parent_id
  ) SELECT r.contest_id,r.area_id,r.total_votes::text official_votes,p.votes::text printed_votes
  FROM area_results r JOIN printed p ON p.contest_id=r.contest_id AND p.parent_id=r.area_id
  JOIN section_counts s ON s.parent_id=r.area_id WHERE r.publication_id=$1 AND r.source_kind='EA20' AND p.n=s.n`,
      [pub],
    )
  ).rows
  const discrepancies = reconciled.filter((r) => r.official_votes !== r.printed_votes)
  if (discrepancies.length)
    throw new Error(`Unreconciled complete zones: ${JSON.stringify(discrepancies.slice(0, 10))}`)
  return {
    scope,
    complete: scope === 'national',
    ...counts,
    ...totals,
    reconciliation: 'total ballots in fully imported zones',
    reconciled_zone_results: reconciled.length,
    discrepancies,
  }
}
export async function publishPublication(client: pg.PoolClient, pub: string) {
  await client.query('BEGIN')
  try {
    const publication = (
      await client.query(
        "SELECT * FROM publications WHERE id=$1 AND status='preparing' FOR UPDATE",
        [pub],
      )
    ).rows[0]
    if (!publication) throw new Error('Preparing publication not found')
    const run = (
      await client.query("SELECT * FROM import_runs WHERE publication_id=$1 AND state='ready'", [
        pub,
      ])
    ).rows[0]
    if (!run) throw new Error('Only validated ready imports can be published')
    await client.query(
      "UPDATE publications SET status='published',published_at=now() WHERE id=$1",
      [pub],
    )
    await client.query('UPDATE editions SET active_publication_id=$2 WHERE id=$1', [
      publication.edition_id,
      pub,
    ])
    await client.query(
      "UPDATE import_runs SET state='published',updated_at=now() WHERE publication_id=$1",
      [pub],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
