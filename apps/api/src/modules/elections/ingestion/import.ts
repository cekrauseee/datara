import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type pg from 'pg'
import { FetchError, Fetcher, InterruptedError } from './fetch.js'
import { BulletinCatalog, normalizeBulletin, normalizeUnified } from './normalize.js'
import { Archive, BASE, hash, removeStaleTemporaryFiles, sectionOutcome } from './source.js'
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
  /** False when EA16 lists no auxiliary file: TSE generates none for sections without urn files. */
  auxiliaryFile?: false
}
type Task = { url: string; kind: string; context: TaskContext; archived: boolean }
type AreaRow = [
  id: string,
  level: string,
  name: string,
  uf: string | null,
  municipality: string | null,
  zone: string | null,
  section: string | null,
  feature: string | null,
  parent: string | null,
  principal: string | null,
]
type UnitFailure = { url: string; kind: string; error: string }
export type PauseReason =
  'stop-after' | 'estimate' | 'interrupted' | 'source-unavailable' | 'unit-failures'
export type ImportResult =
  | {
      publicationId: string
      status: 'paused'
      reason: PauseReason
      processed: number
      error?: string
      failures?: UnitFailure[]
      estimate?: Awaited<ReturnType<typeof estimateVolume>>
    }
  | {
      publicationId: string
      status: 'ready' | 'published'
      coverage: Awaited<ReturnType<typeof validatePublication>> & { selection: unknown }
    }

const MAX_FAILURES = 50
const BATCH = 1000
const ROWS_PER_STATEMENT = 10_000
const RATE_WINDOW_MS = 5 * 60_000
const pad = (value: string, width: number) => value.padStart(width, '0')
const log = (event: Record<string, unknown>) => console.log(JSON.stringify(event))

export async function importElection(pool: pg.Pool, options: ImportOptions): Promise<ImportResult> {
  const pub = options.publicationId ?? randomUUID()
  const keepGoing = options.keepGoing ?? options.scope === 'national'
  const client = await pool.connect()
  // Prefetches stop on any pause, including an interruption while a download is in flight.
  const prefetching = new AbortController()
  const stopPrefetching = () => prefetching.abort()
  options.signal?.addEventListener('abort', stopPrefetching, { once: true })
  const prefetches = new Map<string, Promise<void>>()
  let stats: Record<string, number> = {}
  let cursor: string | undefined
  let progress: NodeJS.Timeout | undefined
  let started = false
  let processed = 0
  const failures: UnitFailure[] = []
  const settle = async () => {
    prefetching.abort()
    await Promise.allSettled(prefetches.values())
  }
  const pause = async (
    reason: PauseReason,
    error: string | null,
    extra: { estimate?: Awaited<ReturnType<typeof estimateVolume>> } = {},
  ): Promise<ImportResult> => {
    await settle()
    await client.query(
      "UPDATE import_runs SET state='paused',error=$2,updated_at=now() WHERE publication_id=$1",
      [pub, error],
    )
    log({
      event: 'paused',
      publicationId: pub,
      reason,
      processed,
      failures: failures.length,
      network: stats,
    })
    return {
      publicationId: pub,
      status: 'paused' as const,
      reason,
      processed,
      ...(error ? { error } : {}),
      ...(failures.length ? { failures } : {}),
      ...extra,
    }
  }
  try {
    // One importer per database; acquisition concurrency lives inside the shared fetcher.
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
      keepGoing: undefined,
      estimate: undefined,
      progressIntervalMs: undefined,
      network: undefined,
      signal: undefined,
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
    const removed = await removeStaleTemporaryFiles(options.archiveDir).catch((error) => {
      log({ event: 'warning', message: `Temporary file cleanup failed: ${error}` })
      return 0
    })
    if (removed) log({ event: 'cleanup', removedTemporaryFiles: removed })
    const fetcher = new Fetcher({ ...options.network, log })
    stats = fetcher.stats
    const archive = new Archive(client, pub, options.archiveDir, {
      offline: options.offline,
      refresh: options.refresh,
      fetcher,
      signal: options.signal,
    })
    const interrupted = () => {
      if (options.signal?.aborted) throw options.signal.reason ?? new InterruptedError('abort')
    }
    const startedAt = performance.now()
    let phase = 'inventory'
    const samples: { t: number; units: number; requests: number }[] = []
    let counts = { expected: 0, completedBefore: 0, pending: 0 }
    const report = () => {
      const now = performance.now()
      samples.push({ t: now, units: processed, requests: fetcher.stats.requests })
      while (samples.length > 2 && now - samples[1]!.t >= RATE_WINDOW_MS) samples.shift()
      const first = samples[0]!
      const seconds = (now - first.t) / 1000
      const unitsPerSecond = seconds > 0 ? (processed - first.units) / seconds : 0
      const remaining = counts.pending - processed - failures.length
      const etaSeconds =
        phase === 'units' && unitsPerSecond > 0 ? Math.round(remaining / unitsPerSecond) : null
      log({
        event: 'progress',
        phase,
        elapsedSeconds: Math.round((now - startedAt) / 1000),
        units: processed,
        failures: failures.length,
        completed: counts.completedBefore + processed,
        expected: counts.expected || null,
        unitsPerSecond: round(unitsPerSecond),
        requestsPerSecond:
          seconds > 0 ? round((fetcher.stats.requests - first.requests) / seconds) : 0,
        network: fetcher.stats,
        etaSeconds,
        eta: etaSeconds === null ? null : new Date(Date.now() + etaSeconds * 1000).toISOString(),
      })
    }
    const interval = options.progressIntervalMs ?? 30_000
    if (interval > 0) progress = setInterval(report, interval).unref()

    const { data: configuration } = await archive.json<Configuration>(
      `${BASE}/comum/config/ele-c.json`,
      'EA11',
    )
    const poll = configuration.pl.find(
      (p) => p.c === 'ele2026' && p.dt === '04/10/2026' && p.e.some((e) => e.t === '1'),
    )
    if (!poll) throw new Error('Official 2026 first-round poll not found')
    const elections = poll.e.filter((e) => e.t === '1')
    await transaction(client, () =>
      upsertAreas(client, pub, [
        ['br', 'country', 'Brasil', null, null, null, null, null, null, null],
        ...Object.keys(regionStates).map((region): AreaRow => [
          `region:${region}`,
          'region',
          region,
          null,
          null,
          null,
          null,
          null,
          'br',
          null,
        ]),
        ['exterior', 'state', 'Exterior', 'zz', null, null, null, null, 'br', null],
      ]),
    )
    const catalogs = new Map<string, Municipalities>()
    for (const election of elections) {
      interrupted()
      const { data } = await archive.json<Municipalities>(
        `${BASE}/ele2026/${election.cd}/config/mun-e${pad(election.cd, 6)}-cm.json`,
        'EA12',
      )
      catalogs.set(election.cd, data)
      const areas: AreaRow[] = []
      for (const state of data.abr) {
        const stateId = state.cd === 'zz' ? 'exterior' : state.cd
        const region = Object.entries(regionStates).find(([, ufs]) => ufs.includes(state.cd))?.[0]
        areas.push([
          stateId,
          'state',
          state.ds,
          state.cd,
          null,
          null,
          null,
          state.cd === 'zz' ? null : (state.mu.find((m) => m.cdi)?.cdi?.slice(0, 2) ?? null),
          region ? `region:${region}` : 'br',
          null,
        ])
        for (const m of state.mu) {
          const id = `${state.cd}:${m.cd}`
          areas.push([
            id,
            'municipality',
            m.nm,
            state.cd,
            m.cd,
            null,
            null,
            m.cdi || null,
            stateId,
            null,
          ])
          for (const z of m.z)
            areas.push([`${id}:${z}`, 'zone', `Zona ${z}`, state.cd, m.cd, z, null, null, id, null])
        }
      }
      await transaction(client, () => upsertAreas(client, pub, areas))
      const contests: unknown[][] = []
      const tasks: [string, string, Partial<TaskContext>][] = []
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
            contests.push([
              id,
              election.cd,
              office.cd,
              office.ds,
              scope,
              office.tp === '2' ? 'proportional' : 'majoritarian',
            ])
            // Candidacy catalog is always populated from the official full contest before local observations.
            const mainUf = office.cd === '1' ? 'br' : state.cd
            const mainPrefix = office.cd === '25' ? `${state.cd}${scope.split(':')[1]}` : mainUf
            tasks.push([
              unifiedUrl(election.cd, office.cd, mainUf, mainPrefix),
              'EA20',
              { contestId: id, areaId: scope, electionId: election.cd, officeCode: office.cd },
            ])
          }
          if (office.cd === '1' && state.cd !== 'br')
            tasks.push([
              unifiedUrl(election.cd, office.cd, state.cd, state.cd),
              'EA20',
              {
                contestId: contestId(election.cd, office.cd, 'br'),
                areaId: state.cd === 'zz' ? 'exterior' : state.cd,
                electionId: election.cd,
                officeCode: office.cd,
              },
            ])
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
            tasks.push([
              unifiedUrl(election.cd, office.cd, state.cd, `${state.cd}${m.cd}`),
              'EA20',
              { ...common, areaId: `${state.cd}:${m.cd}` },
            ])
            for (const z of m.z)
              tasks.push([
                unifiedUrl(election.cd, office.cd, state.cd, `${state.cd}${m.cd}-z${z}`),
                'EA20',
                { ...common, areaId: `${state.cd}:${m.cd}:${z}` },
              ])
          }
        }
      }
      await transaction(client, async () => {
        await insertContests(client, pub, contests)
        await insertTasks(client, pub, tasks)
      })
    }
    // Build the full section inventory, including identifiable aggregated sections without duplicate votes.
    const sectionStates = [
      ...new Set([...catalogs.values()].flatMap((c) => c.abr.map((a) => a.cd))),
    ]
    for (const uf of sectionStates) {
      if (options.scope === 'pilot' && !(options.pilotUfs ?? ['ac', 'df', 'pe', 'zz']).includes(uf))
        continue
      interrupted()
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
      const sectionAreas: AreaRow[] = []
      const sectionCandidates: {
        url: string
        aggregated: boolean
        context: Pick<
          TaskContext,
          'areaId' | 'uf' | 'municipality' | 'zone' | 'section' | 'auxiliaryFile'
        >
      }[] = []
      for (const state of data.abr)
        for (const m of state.mu) {
          if (options.scope === 'pilot' && !chosen.has(m.cd)) continue
          for (const z of m.zon) {
            for (const section of z.sec)
              sectionAreas.push([
                `${uf}:${m.cd}:${z.cd}:${section.ns}`,
                'section',
                `Seção ${section.ns}`,
                uf,
                m.cd,
                z.cd,
                section.ns,
                null,
                `${uf}:${m.cd}:${z.cd}`,
                section.nsp ? `${uf}:${m.cd}:${z.cd}:${section.nsp}` : null,
              ])
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
                  // The official catalog says no auxiliary file exists; requesting it would be a 404.
                  ...(section.da ? {} : { auxiliaryFile: false as const }),
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
      await transaction(client, async () => {
        await upsertAreas(client, pub, sectionAreas)
        await insertTasks(
          client,
          pub,
          selected.map((section) => [section.url, 'EA18', section.context]),
        )
      })
    }
    const total = (
      await client.query(
        `SELECT count(*)::integer AS n,count(*) FILTER(WHERE state='pending')::integer AS pending
         FROM import_tasks WHERE publication_id=$1`,
        [pub],
      )
    ).rows[0]
    await client.query('UPDATE import_runs SET expected_documents=$2 WHERE publication_id=$1', [
      pub,
      total.n,
    ])
    counts = { expected: total.n, completedBefore: total.n - total.pending, pending: total.pending }
    log({
      event: 'inventory',
      publicationId: pub,
      expected: total.n,
      pending: total.pending,
      seconds: round((performance.now() - startedAt) / 1000),
      requests: fetcher.stats.requests,
    })
    if (options.estimate)
      return await pause('estimate', null, {
        estimate: await estimateVolume(client, pub, archive.directory, fetcher.policy),
      })

    // Pending units are listed once per invocation in their semantic order: every EA20 (catalogs
    // and aggregates) before section files, and full contests before local observations.
    cursor = `import_tasks_${randomUUID().replaceAll('-', '')}`
    await client.query(
      `DECLARE ${cursor} NO SCROLL CURSOR WITH HOLD FOR
       SELECT url,kind,context FROM import_tasks WHERE publication_id=$1 AND state='pending'
       ORDER BY CASE WHEN kind='EA20' THEN 0 ELSE 1 END,length(context->>'areaId'),url`,
      [pub],
    )
    const window = archive.offline ? 0 : 4 * fetcher.policy.concurrency
    const queue: Task[] = []
    let exhausted = false
    let prefetchFailure: FetchError | undefined
    const refill = async () => {
      while (!exhausted && queue.length <= window) {
        const rows = (await client.query(`FETCH ${BATCH} FROM ${cursor}`)).rows
        if (rows.length < BATCH) exhausted = true
        if (!rows.length) break
        // Units with a frozen manifest row resume from it and need no prefetch.
        const archived = new Set(
          (
            await client.query(
              'SELECT url FROM source_documents WHERE publication_id=$1 AND url=ANY($2::text[])',
              [pub, rows.map((row) => row.url)],
            )
          ).rows.map((row) => row.url as string),
        )
        for (const row of rows) queue.push({ ...row, archived: archived.has(row.url) })
      }
    }
    const schedule = () => {
      if (prefetchFailure || prefetching.signal.aborted) return
      for (const task of queue.slice(0, window)) {
        if (prefetches.has(task.url) || task.archived || task.context.auxiliaryFile === false)
          continue
        const promise = archive.prefetch(task.url, task.kind, prefetching.signal)
        promise.catch((error) => {
          if (error instanceof FetchError) prefetchFailure ??= error
        })
        prefetches.set(task.url, promise)
      }
    }
    const catalog = new BulletinCatalog(client, pub)
    const unit = async (task: Task) => {
      const context = task.context
      if (task.kind === 'EA18' && context.auxiliaryFile === false) {
        await transaction(client, async () => {
          await client.query(
            "UPDATE import_tasks SET state='official_absence' WHERE publication_id=$1 AND url=$2",
            [pub, task.url],
          )
          await client.query(
            'UPDATE import_runs SET completed_documents=completed_documents+1,updated_at=now() WHERE publication_id=$1',
            [pub],
          )
        })
        return
      }
      const { source, data } = await archive.json<UnifiedResult | Auxiliary>(task.url, task.kind)
      // Sections without a totalized bulletin keep their official EA18 status; unknown states fail.
      const bulletinUrl =
        task.kind === 'EA18' ? sectionOutcome(task.url, data as Auxiliary).bulletinUrl : undefined
      const bulletin = bulletinUrl ? await archive.get(bulletinUrl, 'BU') : undefined
      await transaction(client, async () => {
        if (task.kind === 'EA20')
          await normalizeUnified(client, pub, source, data as UnifiedResult, context)
        else if (bulletin) await normalizeBulletin(client, pub, bulletin, context, catalog)
        await client.query(
          'UPDATE source_documents SET metadata=metadata || $2::jsonb WHERE id=$1',
          [source.id, { normalized: true, officialStatus: (data as Auxiliary).st ?? null }],
        )
        await client.query('UPDATE import_tasks SET state=$3 WHERE publication_id=$1 AND url=$2', [
          pub,
          task.url,
          task.kind === 'EA18' && !bulletin ? 'official_absence' : 'complete',
        ])
        await client.query(
          'UPDATE import_runs SET completed_documents=completed_documents+1,updated_at=now() WHERE publication_id=$1',
          [pub],
        )
      })
    }
    phase = 'units'
    const unitsStartedAt = performance.now()
    // Rates and ETA cover the unit phase only, over a moving window.
    samples.splice(0, samples.length, {
      t: unitsStartedAt,
      units: 0,
      requests: fetcher.stats.requests,
    })
    for (;;) {
      await refill()
      const task = queue[0]
      if (!task) break
      if (options.signal?.aborted) return await pause('interrupted', null)
      if (prefetchFailure) return await pause('source-unavailable', prefetchFailure.message)
      if (options.stopAfter !== undefined && processed >= options.stopAfter)
        return await pause('stop-after', null)
      if (task.kind === 'EA18' && failures.some((failure) => failure.kind === 'EA20'))
        // Bulletins resolve ballot numbers against EA20 candidacies, so those must all be present.
        return await pause(
          'unit-failures',
          `EA20 failures must be resolved before section bulletins. ${summary(failures)}`,
        )
      schedule()
      queue.shift()
      try {
        await prefetches.get(task.url)
        await unit(task)
        processed++
      } catch (error) {
        // A failed rollback means the connection is unusable; nothing else can be recorded.
        await client.query('ROLLBACK').catch(() => {
          throw error
        })
        if (options.signal?.aborted) return await pause('interrupted', null)
        if (error instanceof FetchError) return await pause('source-unavailable', error.message)
        if (!keepGoing || fatal(error)) throw error
        const message = error instanceof Error ? error.message : String(error)
        failures.push({ url: task.url, kind: task.kind, error: message })
        log({ event: 'unit-failed', url: task.url, kind: task.kind, error: message })
        if (failures.length >= MAX_FAILURES)
          return await pause(
            'unit-failures',
            `Stopped at ${MAX_FAILURES} failures. ${summary(failures)}`,
          )
      } finally {
        prefetches.delete(task.url)
      }
    }
    const unitSeconds = (performance.now() - unitsStartedAt) / 1000
    log({
      event: 'units',
      publicationId: pub,
      units: processed,
      failures: failures.length,
      seconds: round(unitSeconds),
      unitsPerSecond: unitSeconds > 0 ? round(processed / unitSeconds) : null,
      network: fetcher.stats,
    })
    if (failures.length) return await pause('unit-failures', summary(failures))
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
      status: options.publish === false ? ('ready' as const) : ('published' as const),
      coverage,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    // Interruptions and unavailable sources leave a resumable publication, never a failed one.
    if (started && (options.signal?.aborted || error instanceof FetchError))
      return await pause(
        options.signal?.aborted ? 'interrupted' : 'source-unavailable',
        options.signal?.aborted ? null : (error as Error).message,
      )
    if (started)
      await client
        .query(
          "UPDATE import_runs SET state='failed',error=$2,updated_at=now() WHERE publication_id=$1",
          [pub, error instanceof Error ? error.message : String(error)],
        )
        .catch(() => {})
    throw error
  } finally {
    clearInterval(progress)
    options.signal?.removeEventListener('abort', stopPrefetching)
    await settle()
    if (cursor) await client.query(`CLOSE ${cursor}`).catch(() => {})
    await client.query('SELECT pg_advisory_unlock(202602)').catch(() => {})
    client.release()
  }
}
function summary(failures: UnitFailure[]) {
  const first = failures
    .slice(0, 5)
    .map((failure) => `${failure.url}: ${failure.error}`)
    .join('; ')
  return `${failures.length} unit(s) failed and remain pending; ${first}`
}
// Connection, resource and server failures stop the run instead of being recorded per unit.
function fatal(error: unknown) {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^(08|53|57|58|XX)/.test(code)
}
function round(value: number) {
  return Math.round(value * 100) / 100
}
async function transaction<T>(client: pg.PoolClient, work: () => Promise<T>) {
  await client.query('BEGIN')
  try {
    const result = await work()
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
async function upsertAreas(client: pg.PoolClient, pub: string, rows: AreaRow[]) {
  // Same result as row-by-row upserts: the first row inserts, later duplicates update feature_id.
  const unique = new Map<string, AreaRow>()
  for (const row of rows) {
    const first = unique.get(row[0])
    if (first) first[7] = row[7]
    else unique.set(row[0], [...row])
  }
  const all = [...unique.values()]
  for (let i = 0; i < all.length; i += ROWS_PER_STATEMENT)
    await client.query(
      `INSERT INTO areas(publication_id,id,level,name,uf,municipality_code,zone_code,section_code,feature_id,parent_id,principal_area_id)
  SELECT $1,* FROM unnest($2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::text[],$10::text[],$11::text[])
  ON CONFLICT(publication_id,id) DO UPDATE SET feature_id=excluded.feature_id`,
      [pub, ...transpose(all.slice(i, i + ROWS_PER_STATEMENT), 10)],
    )
}
async function insertContests(client: pg.PoolClient, pub: string, rows: unknown[][]) {
  const unique = new Map<unknown, unknown[]>()
  for (const row of rows) if (!unique.has(row[0])) unique.set(row[0], row)
  const all = [...unique.values()]
  for (let i = 0; i < all.length; i += ROWS_PER_STATEMENT)
    await client.query(
      `INSERT INTO contests(publication_id,id,election_id,office_code,office_name,scope_area_id,vote_type)
  SELECT $1,* FROM unnest($2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::text[]) ON CONFLICT DO NOTHING`,
      [pub, ...transpose(all.slice(i, i + ROWS_PER_STATEMENT), 6)],
    )
}
async function insertTasks(
  client: pg.PoolClient,
  pub: string,
  rows: [string, string, Partial<TaskContext>][],
) {
  // The first occurrence of a URL wins, as ON CONFLICT DO NOTHING does across statements.
  const unique = new Map<string, unknown[]>()
  for (const [url, kind, context] of rows)
    if (!unique.has(url)) unique.set(url, [url, kind, JSON.stringify(context)])
  const all = [...unique.values()]
  for (let i = 0; i < all.length; i += ROWS_PER_STATEMENT)
    await client.query(
      `INSERT INTO import_tasks(publication_id,url,kind,context)
  SELECT $1,url,kind,context::jsonb FROM unnest($2::text[],$3::text[],$4::text[]) AS t(url,kind,context)
  ON CONFLICT DO NOTHING`,
      [pub, ...transpose(all.slice(i, i + ROWS_PER_STATEMENT), 3)],
    )
}
function transpose(rows: unknown[][], width: number) {
  const columns: unknown[][] = Array.from({ length: width }, () => [])
  for (const row of rows) row.forEach((value, index) => columns[index]!.push(value))
  return columns
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

// Measured on the archived pilot: mean auxiliary and BU sizes, rows written per domestic BU
// (lower bound; large urban sections are expected near the upper one), on-disk bytes per row
// with indexes, normalization cost and warm-connection TSE latency.
const ESTIMATE = {
  auxiliaryBytes: 524,
  bulletinBytes: 12_750,
  bulletinRows: [320, 600],
  aggregateRowBytes: 425,
  bulletinRowBytes: 320,
  msPerRow: 0.0125,
  msPerUnit: 5,
  latencySeconds: 0.41,
  blockBytes: 4096,
}
/** Expected remaining volume from the inventory and the archived contest-level EA20 files. */
export async function estimateVolume(
  client: pg.PoolClient,
  pub: string,
  directory: string,
  policy: { rate: number; concurrency: number },
) {
  const tasks = (
    await client.query(
      `SELECT kind,count(*)::integer total,count(*) FILTER(WHERE state='pending')::integer pending,
       count(*) FILTER(WHERE state='pending' AND context->>'auxiliaryFile'='false')::integer without_auxiliary
       FROM import_tasks WHERE publication_id=$1 GROUP BY kind`,
      [pub],
    )
  ).rows
  const contests = (
    await client.query(
      `SELECT c.id,c.election_id,c.office_code,c.scope_area_id,count(t.url)::integer pending
       FROM contests c JOIN import_tasks t ON t.publication_id=c.publication_id AND t.kind='EA20'
       AND t.state='pending' AND t.context->>'contestId'=c.id
       WHERE c.publication_id=$1 GROUP BY c.publication_id,c.id`,
      [pub],
    )
  ).rows
  // A contest's local EA20 files list the same candidacies as its archived full-contest file.
  const known: { pending: number; bytes: number; rows: number }[] = []
  let unknownTasks = 0
  for (const contest of contests) {
    const [uf, municipality] = String(contest.scope_area_id).split(':')
    const mainUf = contest.office_code === '1' ? 'br' : uf!
    const url = unifiedUrl(
      contest.election_id,
      contest.office_code,
      mainUf,
      contest.office_code === '25' ? `${mainUf}${municipality}` : mainUf,
    )
    try {
      const reference = JSON.parse(
        await readFile(join(directory, 'urls', `${hash(Buffer.from(url))}.json`), 'utf8'),
      ) as { sha256: string }
      const bytes = await readFile(join(directory, 'sha256', reference.sha256))
      const data = JSON.parse(bytes.toString('utf8')) as UnifiedResult
      const parties = data.carg[0]?.agr.flatMap((group) => group.par) ?? []
      const candidates = parties
        .flatMap((party) => party.cand ?? [])
        .filter((c) => c.vap !== undefined)
      known.push({
        pending: contest.pending,
        bytes: (await stat(join(directory, 'sha256', reference.sha256))).size,
        rows: 1 + parties.length + candidates.length,
      })
    } catch {
      unknownTasks += contest.pending
    }
  }
  const knownTasks = known.reduce((n, k) => n + k.pending, 0)
  const mean = (pick: (k: (typeof known)[number]) => number) =>
    knownTasks ? known.reduce((n, k) => n + k.pending * pick(k), 0) / knownTasks : 0
  const blocks = (bytes: number) => Math.ceil(bytes / ESTIMATE.blockBytes) * ESTIMATE.blockBytes
  const ea20 = {
    pending: knownTasks + unknownTasks,
    bytes: known.reduce((n, k) => n + k.pending * k.bytes, 0) + unknownTasks * mean((k) => k.bytes),
    allocated:
      known.reduce((n, k) => n + k.pending * blocks(k.bytes), 0) +
      unknownTasks * blocks(mean((k) => k.bytes)),
    rows: known.reduce((n, k) => n + k.pending * k.rows, 0) + unknownTasks * mean((k) => k.rows),
  }
  const sections = tasks.find((t) => t.kind === 'EA18') ?? {
    total: 0,
    pending: 0,
    without_auxiliary: 0,
  }
  const withFiles = sections.pending - sections.without_auxiliary
  const requests = ea20.pending + 2 * withFiles
  const bulletinRows = ESTIMATE.bulletinRows.map((perSection) => withFiles * perSection)
  const rows = bulletinRows.map((n) => Math.round(ea20.rows + n))
  const logicalBytes = ea20.bytes + withFiles * (ESTIMATE.auxiliaryBytes + ESTIMATE.bulletinBytes)
  const rate = Math.min(policy.rate, policy.concurrency / ESTIMATE.latencySeconds)
  const network = requests / rate / 3600
  const normalization = rows.map(
    (n) => (n * ESTIMATE.msPerRow + (ea20.pending + sections.pending) * ESTIMATE.msPerUnit) / 3.6e6,
  )
  const gb = (bytes: number) => round(bytes / 1e9)
  return {
    note: 'Estimate only: no EA20, EA18 or BU result file was downloaded; only the EA11/EA12/EA16 catalogs.',
    tasks: Object.fromEntries(
      tasks.map((t) => [
        t.kind,
        { total: t.total, pending: t.pending, withoutAuxiliaryFile: t.without_auxiliary },
      ]),
    ),
    requests,
    archive: {
      gigabytes: gb(logicalBytes),
      // Every source and URL reference occupies whole filesystem blocks.
      allocatedGigabytes: gb(
        ea20.allocated +
          withFiles * (blocks(ESTIMATE.auxiliaryBytes) + blocks(ESTIMATE.bulletinBytes)) +
          requests * ESTIMATE.blockBytes,
      ),
    },
    database: {
      rows,
      gigabytes: bulletinRows.map((n) =>
        gb(ea20.rows * ESTIMATE.aggregateRowBytes + n * ESTIMATE.bulletinRowBytes),
      ),
    },
    hours: {
      network: round(network),
      normalization: normalization.map(round),
      // Downloads and normalization overlap, so the slower stage dominates.
      total: normalization.map((n) => round(Math.max(n, network))),
    },
    assumptions: {
      ratePerSecond: policy.rate,
      concurrency: policy.concurrency,
      effectiveRequestsPerSecond: round(rate),
      ...ESTIMATE,
      contestTasksWithoutArchivedMainFile: unknownTasks,
    },
  }
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
  // Official section situations: the EA18 status, or no auxiliary file at all per EA16.
  const statuses = (
    await client.query(
      `SELECT coalesce(s.metadata->>'officialStatus','') status,
  count(*) FILTER(WHERE t.context->>'auxiliaryFile'='false')::integer without_file,count(*)::integer n
  FROM import_tasks t LEFT JOIN source_documents s ON s.publication_id=t.publication_id AND s.url=t.url
  WHERE t.publication_id=$1 AND t.kind='EA18' GROUP BY 1 ORDER BY 1`,
      [pub],
    )
  ).rows
  // Sections without an auxiliary file must be explained by the zone's official EA20 totals of
  // non-installed or uncounted sections; otherwise the section catalog may be stale.
  const unexplained = (
    await client.query(
      `WITH absent AS (
   SELECT a.parent_id,count(*)::integer n FROM import_tasks t
   JOIN areas a ON a.publication_id=t.publication_id AND a.id=t.context->>'areaId'
   WHERE t.publication_id=$1 AND t.kind='EA18' AND t.context->>'auxiliaryFile'='false' GROUP BY a.parent_id
  ) SELECT x.parent_id zone,x.n,r.contest_id,r.metadata->'sectionTotals'->>'sni' not_installed,
  r.metadata->'sectionTotals'->>'sna' not_counted
  FROM absent x LEFT JOIN area_results r ON r.publication_id=$1 AND r.area_id=x.parent_id AND r.source_kind='EA20'
  WHERE r.contest_id IS NULL OR x.n > coalesce((r.metadata->'sectionTotals'->>'sni')::integer,0)
   + coalesce((r.metadata->'sectionTotals'->>'sna')::integer,0)`,
      [pub],
    )
  ).rows
  if (unexplained.length)
    throw new Error(
      `Sections without auxiliary file not explained by EA20 zone totals: ${JSON.stringify(unexplained.slice(0, 10))}`,
    )
  // A zone is comparable when each principal section has a BU or an official status without
  // one. EA20 judicial destinations differ from printed BU, so compare total ballots, never
  // silently relabel nominal BU counts as valid candidate votes.
  const zones = (
    await client.query(
      `WITH section_counts AS (
   SELECT parent_id,count(*) FILTER(WHERE principal_area_id IS NULL)::integer n FROM areas WHERE publication_id=$1 AND level='section' GROUP BY parent_id
  ), absent AS (
   SELECT a.parent_id,count(*)::integer n FROM import_tasks t
   JOIN areas a ON a.publication_id=t.publication_id AND a.id=t.context->>'areaId'
   WHERE t.publication_id=$1 AND t.kind='EA18' AND t.state='official_absence' GROUP BY a.parent_id
  ), printed AS (
   SELECT r.contest_id,a.parent_id,sum(r.total_votes) votes,count(*)::integer n FROM area_results r JOIN areas a USING(publication_id)
   WHERE r.publication_id=$1 AND r.source_kind='BU' AND a.id=r.area_id GROUP BY r.contest_id,a.parent_id
  ) SELECT r.contest_id,r.area_id,r.total_votes::text official_votes,coalesce(p.votes,0)::text printed_votes,
  coalesce(p.n,0)+coalesce(x.n,0)=s.n covered
  FROM area_results r JOIN areas z ON z.publication_id=r.publication_id AND z.id=r.area_id AND z.level='zone'
  LEFT JOIN section_counts s ON s.parent_id=r.area_id
  LEFT JOIN printed p ON p.contest_id=r.contest_id AND p.parent_id=r.area_id
  LEFT JOIN absent x ON x.parent_id=r.area_id
  WHERE r.publication_id=$1 AND r.source_kind='EA20' ORDER BY r.contest_id,r.area_id`,
      [pub],
    )
  ).rows
  const reconciled = zones
    .filter((zone) => zone.covered)
    .map(({ contest_id, area_id, official_votes, printed_votes }) => ({
      contest_id,
      area_id,
      official_votes,
      printed_votes,
    }))
  const discrepancies = reconciled.filter((r) => r.official_votes !== r.printed_votes)
  if (discrepancies.length)
    throw new Error(`Unreconciled complete zones: ${JSON.stringify(discrepancies.slice(0, 10))}`)
  return {
    scope,
    complete: scope === 'national',
    ...counts,
    ...totals,
    reconciliation:
      'total ballots in zones where every principal section has a BU or an official status without one',
    reconciled_zone_results: reconciled.length,
    discrepancies,
    unreconciledZoneResults: zones.length - reconciled.length,
    officialSectionStatuses: Object.fromEntries(
      statuses.filter((row) => row.status).map((row) => [row.status, row.n]),
    ),
    sectionsWithoutAuxiliaryFile: statuses.reduce((n, row) => n + row.without_file, 0),
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
