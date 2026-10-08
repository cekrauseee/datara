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
import { BASE, hash, sectionOutcome } from '../src/modules/elections/ingestion/source.js'
import {
  type Auxiliary,
  type ImportOptions,
  type UnifiedResult,
  contestScope,
} from '../src/modules/elections/ingestion/types.js'

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

// EA18 interpretation with synthetic fixtures: official statuses without a totalized bulletin are
// recorded as such; unknown or inconsistent states fail instead of becoming absences or zeros.
{
  const aux = `${BASE}/ele2026/arquivo-urna/3220/dados/ac/01066/0004/0077/p003220-ac-m01066-z0004-s0077-aux.json`
  const directory = aux.slice(0, aux.lastIndexOf('/'))
  const file = (hash: string, st: string, ...arq: [string, string][]) => ({
    hash,
    st,
    arq: arq.map(([nm, tp]) => ({ nm, tp })),
  })
  const outcome = (st: string, hashes: Auxiliary['hashes']) =>
    sectionOutcome(aux, { f: 'o', st, hashes })
  assert.deepEqual(
    outcome('Totalizada', [
      file('aa11', 'Excluído', ['old-bu.dat', 'bu']),
      file('bb22', 'Totalizado', ['o-rdv.dat', 'rdv'], ['o-bu.dat', 'bu']),
      file('cc33', 'Rejeitado', ['bad-bu.dat', 'bu']),
      file('dd44', 'Recebido', ['new-bu.dat', 'bu']),
    ]),
    { officialStatus: 'Totalizada', bulletinUrl: `${directory}/bb22/o-bu.dat` },
  )
  assert.equal(
    outcome('Totalizada', [file('ee55', 'Totalizado', ['o-busa.dat', 'busa'])]).bulletinUrl,
    `${directory}/ee55/o-busa.dat`,
  )
  for (const st of ['Não instalada', 'Não Instalada', 'Não apurada', 'Anulada']) {
    assert.deepEqual(
      outcome(st, [
        file('ff66', 'Excluído', ['o-bu.dat', 'bu']),
        file('aa77', 'Totalizado', ['o-rdv.dat', 'rdv'], ['o.jez', 'log']),
      ]),
      { officialStatus: st },
    )
    assert.throws(
      () => outcome(st, [file('ff66', 'Totalizado', ['o-bu.dat', 'bu'])]),
      /contradicts a totalized BU/,
    )
  }
  // Files received but not totalized are a transient state, never an absence.
  assert.throws(
    () => outcome('Recebida', [file('ff66', 'Recebido', ['o-bu.dat', 'bu'])]),
    /not totalized/,
  )
  assert.deepEqual(sectionOutcome(aux, { f: 'o', st: 'Não instalada' }), {
    officialStatus: 'Não instalada',
  })
  assert.throws(() => outcome('Cancelada', []), /Unknown EA18 section status/)
  assert.throws(() => outcome('Totalizada', [file('aa11', 'Substituído')]), /Unknown EA18 hash/)
  assert.throws(
    () =>
      outcome('Totalizada', [
        file('aa11', 'Totalizado', ['a-bu.dat', 'bu']),
        file('bb22', 'Totalizado', ['b-bu.dat', 'bu']),
      ]),
    /Multiple totalized/,
  )
  assert.throws(
    () => outcome('Totalizada', [file('aa11', 'Recebido', ['a-bu.dat', 'bu'])]),
    /no totalized BU/,
  )
  assert.throws(
    () => outcome('Totalizada', [file('aa11', 'Totalizado', ['a.jez', 'log'])]),
    /no totalized BU/,
  )
  assert.throws(
    () => outcome('Totalizada', [file('../x', 'Totalizado', ['a-bu.dat', 'bu'])]),
    /Invalid BU/,
  )
}

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
// Archived bytes of an official URL, as the offline importer reads them.
async function archived(url: string) {
  const reference = JSON.parse(
    await readFile(join(options.archiveDir, 'urls', `${hash(Buffer.from(url))}.json`), 'utf8'),
  ) as { sha256: string }
  const bytes = await readFile(join(options.archiveDir, 'sha256', reference.sha256))
  return { bytes, sha256: reference.sha256, data: JSON.parse(bytes.toString('utf8')) }
}
const state = async (pub: string) =>
  (await pool.query('SELECT state,error FROM import_runs WHERE publication_id=$1', [pub])).rows[0]
try {
  await migrate(pool)
  // A new database applies every migration once, in order; repeating migrate applies nothing.
  const ledger = async () =>
    (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name)
  assert.deepEqual(await ledger(), ['001-election', '002-areas-parent'])
  await migrate(pool)
  assert.deepEqual(await ledger(), ['001-election', '002-areas-parent'])
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::integer AS n FROM pg_indexes WHERE schemaname=current_schema() AND indexname='areas_parent'",
      )
    ).rows[0].n,
    1,
  )
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
  // The scope document of each contest, which carries its candidacy catalog, is normalized before
  // any other EA20 document; the first one is the national presidential file.
  const completedTasks = async () =>
    (
      await pool.query(
        "SELECT url,context FROM import_tasks WHERE publication_id=$1 AND state='complete'",
        [paused.publicationId],
      )
    ).rows as { url: string; context: { contestId: string; areaId: string } }[]
  assert.deepEqual(
    (await completedTasks()).map((task) => task.url),
    [`${BASE}/ele2026/6257/dados/br/br-c0001-e006257-u.json`],
  )
  {
    const client = await pool.connect()
    try {
      // A local document whose contest has no catalog yet fails clearly instead of hitting a
      // foreign key; a local candidacy missing from an existing catalog fails as well.
      const local = async (
        url: string,
        context: Record<string, string>,
        edit?: (data: UnifiedResult) => void,
      ) => {
        const { bytes, sha256, data } = await archived(url)
        edit?.(data)
        const id = randomUUID()
        await client.query('BEGIN')
        try {
          await client.query(
            "INSERT INTO source_documents(id,publication_id,url,sha256,archive_path,kind) VALUES($1,$2,$3,$4,$5,'EA20')",
            [id, paused.publicationId, url, sha256, `sha256/${sha256}`],
          )
          await normalizeUnified(
            client,
            paused.publicationId,
            { id, bytes, sha256, url },
            data,
            context as never,
          )
        } finally {
          await client.query('ROLLBACK')
        }
      }
      await assert.rejects(
        local(`${BASE}/ele2026/6259/dados/ac/ac01066-c0003-e006259-u.json`, {
          contestId: 'BR-2026-1:6259:3:ac',
          areaId: 'ac:01066',
          electionId: '6259',
          officeCode: '3',
        }),
        /Catalog for BR-2026-1:6259:3:ac must precede/,
      )
      await assert.rejects(
        local(
          `${BASE}/ele2026/6257/dados/ac/ac-c0001-e006257-u.json`,
          { contestId: 'BR-2026-1:6257:1:br', areaId: 'ac', electionId: '6257', officeCode: '1' },
          (data) => {
            const party = data.carg[0]!.agr[0]!.par[0]!
            party.cand = [...party.cand, { ...party.cand[0]!, sqcand: '999999999999' }]
          },
        ),
        /Candidacies absent from the BR-2026-1:6257:1:br catalog \(BR-2026-1:6257:1:br:999999999999\)/,
      )
    } finally {
      client.release()
    }
  }
  const contestCount = (
    await pool.query('SELECT count(*)::integer n FROM contests WHERE publication_id=$1', [
      paused.publicationId,
    ])
  ).rows[0].n
  await importElection(pool, {
    ...options,
    publicationId: paused.publicationId,
    stopAfter: contestCount - 1,
  })
  const catalogTasks = await completedTasks()
  assert.equal(catalogTasks.length, contestCount)
  assert.ok(
    catalogTasks.every((task) => task.context.areaId === contestScope(task.context.contestId)),
    'every contest scope document precedes other EA20 documents',
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
    // Fernando de Noronha's council is non-partisan: TSE's empty party rows are not parties.
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::integer n FROM parties WHERE abbreviation='' OR name=''",
        )
      ).rows[0].n,
      0,
    )
    assert.deepEqual(
      (
        await client.query(
          `SELECT count(*)::integer n,count(*) FILTER(WHERE party_number IS NULL AND coalition IS NULL AND federation IS NULL)::integer non_partisan,
           (SELECT count(*)::integer FROM party_results WHERE publication_id=$1 AND contest_id=$2) party_results
           FROM candidacies WHERE publication_id=$1 AND contest_id=$2`,
          [pub, 'BR-2026-1:6261:25:pe:30015'],
        )
      ).rows[0],
      { n: 22, non_partisan: 22, party_results: 0 },
    )
    // Catalogs come from each contest's scope document: no empty or missing official status, and
    // the presidential statuses are those of the national file.
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::integer n FROM candidacies WHERE publication_id=$1 AND (status IS NULL OR status='')",
          [pub],
        )
      ).rows[0].n,
      0,
    )
    const national = (await archived(`${BASE}/ele2026/6257/dados/br/br-c0001-e006257-u.json`))
      .data as UnifiedResult
    const nationalStatus = Object.fromEntries(
      national.carg[0]!.agr.flatMap((g) =>
        g.par.flatMap((party) => party.cand.map((c) => [`BR-2026-1:6257:1:br:${c.sqcand}`, c.st])),
      ),
    )
    const presidential = (
      await client.query(
        "SELECT id,status FROM candidacies WHERE publication_id=$1 AND contest_id='BR-2026-1:6257:1:br'",
        [pub],
      )
    ).rows
    assert.deepEqual(
      Object.fromEntries(presidential.map((row) => [row.id, row.status])),
      nationalStatus,
    )
    // Every BU result keeps its printed totals by vote type, which add up to its total votes.
    assert.deepEqual(
      (
        await client.query(
          `SELECT count(*)::integer n,count(*) FILTER(WHERE (SELECT sum(value::bigint) FROM jsonb_each_text(metadata->'printedVoteTotals') WHERE key<>'total')=total_votes
           AND (metadata->'printedVoteTotals'->>'total')::bigint=total_votes AND (metadata->'printedVoteTotals'->>'null')::bigint=null_votes)::integer consistent
           FROM area_results WHERE publication_id=$1 AND source_kind='BU'`,
          [pub],
        )
      ).rows[0],
      { n: 32, consistent: 32 },
    )
    assert.deepEqual(
      (
        await client.query(
          "SELECT name FROM areas WHERE publication_id=$1 AND level='region' ORDER BY id",
          [pub],
        )
      ).rows.map((row) => row.name),
      ['Centro-Oeste', 'Norte', 'Nordeste', 'Sul', 'Sudeste'],
    )
    const exterior = (
      await client.query(
        "SELECT eligible,turnout FROM area_results WHERE publication_id=$1 AND area_id='zz:29254:0001:0001'",
        [pub],
      )
    ).rows[0]
    assert.deepEqual(exterior, { eligible: '91', turnout: '44' })
    const coverage = (await client.query('SELECT coverage FROM publications WHERE id=$1', [pub]))
      .rows[0].coverage
    assert.deepEqual(coverage.officialSectionStatuses, { Totalizada: 7 })
    assert.equal(coverage.sectionsWithoutAuxiliaryFile, 0)
    assert.equal(coverage.reconciled_zone_results, 1)
    assert.ok(coverage.unreconciledZoneResults > 0)

    // A zone whose sections all have a BU or an official status without one is reconciled; an
    // official absence covers its section and contributes no printed ballots.
    const exteriorSection = (
      await client.query(
        "SELECT url FROM import_tasks WHERE publication_id=$1 AND context->>'areaId'='zz:29254:0001:0001'",
        [pub],
      )
    ).rows[0].url
    const absent = async (withoutFile: boolean) => {
      await client.query(
        `UPDATE import_tasks SET state='official_absence',context=context || $3::jsonb
         WHERE publication_id=$1 AND url=$2`,
        [pub, exteriorSection, withoutFile ? { auxiliaryFile: false } : {}],
      )
      await client.query(
        "DELETE FROM area_results WHERE publication_id=$1 AND area_id='zz:29254:0001:0001'",
        [pub],
      )
    }
    await client.query('BEGIN')
    await absent(false)
    await assert.rejects(
      validatePublication(client, pub, 'pilot'),
      /Unreconciled complete zones.*zz:29254:0001/,
    )
    await client.query(
      "UPDATE area_results SET total_votes=0 WHERE publication_id=$1 AND area_id='zz:29254:0001' AND source_kind='EA20'",
      [pub],
    )
    const covered = await validatePublication(client, pub, 'pilot')
    assert.equal(covered.reconciled_zone_results, 1)
    assert.equal(covered.official_absences, 1)
    await client.query('ROLLBACK')
    // Sections with no auxiliary file must be explained by the zone's EA20 section totals.
    await client.query('BEGIN')
    await absent(true)
    await client.query(
      "UPDATE area_results SET total_votes=0 WHERE publication_id=$1 AND area_id='zz:29254:0001' AND source_kind='EA20'",
      [pub],
    )
    await assert.rejects(
      validatePublication(client, pub, 'pilot'),
      /not explained by EA20 zone totals/,
    )
    await client.query(
      `UPDATE area_results SET metadata=jsonb_set(metadata,'{sectionTotals,sni}','"1"')
       WHERE publication_id=$1 AND area_id='zz:29254:0001' AND source_kind='EA20'`,
      [pub],
    )
    assert.equal((await validatePublication(client, pub, 'pilot')).sectionsWithoutAuxiliaryFile, 1)
    await client.query('ROLLBACK')

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

    // Official EA18 statuses without a totalized BU, and sections without any auxiliary file.
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
      EA18: { total: 7, pending: 7, withoutAuxiliaryFile: 0 },
      EA20: { total: 261, pending: 261, withoutAuxiliaryFile: 0 },
    })
    assert.equal(estimated.estimate!.requests, 261 + 2 * 7)
    const statuses = estimated.publicationId
    const section = async (areaId: string) =>
      (
        await client.query(
          "SELECT url FROM import_tasks WHERE publication_id=$1 AND context->>'areaId'=$2",
          [statuses, areaId],
        )
      ).rows[0].url as string
    const withoutFile = await section('ac:01066:0004:0077')
    const annulled = await section('ac:01066:0004:0078')
    const notInstalled = await section('df:97012:0002:0478')
    await client.query(
      `UPDATE import_tasks SET context=context || '{"auxiliaryFile":false}' WHERE publication_id=$1 AND url=$2`,
      [statuses, withoutFile],
    )
    const annulledBulletin = `${annulled.slice(0, annulled.lastIndexOf('/'))}/abc123/o-bu.dat`
    const synthetic = scriptedTse({
      replace: new Map<string, unknown>([
        [
          annulled,
          {
            f: 'o',
            st: 'Anulada',
            hashes: [{ hash: 'abc123', st: 'Excluído', arq: [{ nm: 'o-bu.dat', tp: 'bu' }] }],
          },
        ],
        [notInstalled, { f: 'o', st: 'Não instalada', hashes: [] }],
      ]),
    })
    await assert.rejects(
      importElection(pool, {
        ...options,
        offline: false,
        archiveDir: statusArchive,
        publicationId: statuses,
        network: { ...network, fetch: synthetic.fetch },
      }),
      /Sections without auxiliary file not explained by EA20 zone totals/,
    )
    assert.ok(
      !synthetic.requests.includes(withoutFile),
      'no request for a file EA16 says is absent',
    )
    assert.ok(!synthetic.requests.includes(annulledBulletin), 'no BU for an annulled section')
    const recorded = (
      await client.query(
        `SELECT t.context->>'areaId' area,t.state,s.metadata->>'officialStatus' status,
         (SELECT count(*)::integer FROM area_results r WHERE r.publication_id=t.publication_id AND r.area_id=t.context->>'areaId') results
         FROM import_tasks t LEFT JOIN source_documents s ON s.publication_id=t.publication_id AND s.url=t.url
         WHERE t.publication_id=$1 AND t.url=ANY($2::text[]) ORDER BY 1`,
        [statuses, [withoutFile, annulled, notInstalled]],
      )
    ).rows
    assert.deepEqual(recorded, [
      { area: 'ac:01066:0004:0077', state: 'official_absence', status: null, results: 0 },
      { area: 'ac:01066:0004:0078', state: 'official_absence', status: 'Anulada', results: 0 },
      {
        area: 'df:97012:0002:0478',
        state: 'official_absence',
        status: 'Não instalada',
        results: 0,
      },
    ])
    await client.query(
      `UPDATE area_results SET metadata=jsonb_set(metadata,'{sectionTotals,sni}','"1"')
       WHERE publication_id=$1 AND area_id='ac:01066:0004' AND source_kind='EA20'`,
      [statuses],
    )
    const official = await validatePublication(client, statuses, 'pilot')
    assert.deepEqual(official.officialSectionStatuses, {
      Anulada: 1,
      'Não instalada': 1,
      Totalizada: 4,
    })
    assert.equal(official.sectionsWithoutAuxiliaryFile, 1)
    assert.equal(official.official_absences, 3)

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
          'offline replay, interrupted publication, idempotent resume, lower correction replacement, incompatible candidacy FK, aggregate nonduplication, retained prior publication, IBGE state IDs, EA18 status fixtures, reconciliation with official absences, sections without auxiliary file, scripted online acquisition with 404 pause/interruption/resume equal to offline, estimate without result downloads, legacy resume options, keep-going with EA20 gate, mid-queue stop at concurrency 4 equal to sequential, scope-document catalogs first with clear errors otherwise, non-partisan council without placeholder parties, printed BU totals by vote type, Portuguese region names',
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
