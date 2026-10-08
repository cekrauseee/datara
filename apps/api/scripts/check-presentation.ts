import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.js'
import { readConfig } from '../src/config.js'
import { createPool } from '../src/db/index.js'
import { contrast, deltaE, oklchToHex } from '../src/modules/elections/color.js'
import { EDITION } from '../src/modules/elections/ingestion/types.js'
import {
  FALLBACK_COLORS,
  NEUTRAL_COLOR,
  candidatePhotoFile,
  configuredColor,
  deriveShade,
  fallbackColor,
  loadPresentation,
  readEditorial,
} from '../src/modules/elections/presentation.js'

// Two candidacies of one majoritarian contest closer than this OKLab distance read as one color.
const MIN_DISTANCE = 0.04
// Light and dark theme background and --muted surfaces (packages/theme/theme.css).
const SURFACES = [1, 0.97, 0.269, 0.145].map((L) => oklchToHex({ L, C: 0, h: 0 }))
type Candidacy = {
  contest_id: string
  id: string
  number: string
  display_name: string
  party_number: string | null
  abbreviation: string | null
}
const compare = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)
const byNumber = (a: Candidacy, b: Candidacy) => compare(a.number, b.number) || compare(a.id, b.id)
const label = (c: Candidacy) =>
  `${c.contest_id} ${c.number} ${c.display_name} (${c.abbreviation || 'no party'} ${c.party_number ?? '-'})`

async function checkResolution() {
  const dir = await mkdtemp(join(tmpdir(), 'datara-photos-'))
  try {
    await mkdir(join(dir, 'photos'))
    const id = 'BR-2026-1:6257:1:br:280002551544'
    const config = join(dir, 'presentation.json')
    await writeFile(config, JSON.stringify({ candidates: {}, parties: {} }))
    const candidate = { id, number: '13', display_name: 'Official name', party_number: '13' }
    const unconfigured = await loadPresentation(config, '/assets', dir)
    assert.equal(unconfigured(candidate).photoUrl, null)
    assert.equal(unconfigured(candidate).color, FALLBACK_COLORS[5])
    assert.equal(unconfigured(candidate).partyDisplayName, null)
    // Without a party (non-partisan contests) the fallback is indexed by the ballot number.
    assert.equal(
      unconfigured({ ...candidate, number: '170', party_number: null }).color,
      FALLBACK_COLORS[170 % 8],
    )
    assert.equal(fallbackColor({ number: 'x', party_number: null }), NEUTRAL_COLOR)
    await writeFile(join(dir, candidatePhotoFile(id)), 'JPEG fixture')
    assert.equal(
      (await loadPresentation(config, '/assets', dir))(candidate).photoUrl,
      `/assets/${candidatePhotoFile(id)}`,
    )
    await writeFile(join(dir, 'photos', 'override.jpg'), 'JPEG override fixture')
    await writeFile(
      config,
      JSON.stringify({
        candidates: {
          [id]: { photo: 'photos/override.jpg', displayName: 'Override', color: '#123456' },
        },
        parties: { 13: { displayName: 'Local party', color: '#dc2626', note: 'Fixture' } },
      }),
    )
    const present = await loadPresentation(config, '/assets', dir)
    const presentation = present(candidate)
    assert.equal(presentation.photoUrl, '/assets/photos/override.jpg')
    assert.equal(presentation.displayName, 'Override')
    assert.equal(presentation.color, '#123456')
    assert.equal(presentation.partyDisplayName, 'Local party')
    assert.equal(present({ ...candidate, id: `${id}0` }).color, '#dc2626')
    console.log(
      'Presentation precedence passed: photo override -> official -> null; color candidate -> party -> fallback by party number, or by ballot number without party',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  // Pinned values keep pasted overrides reproducible.
  assert.equal(deriveShade('#4466e7', 1), '#9548cc')
  assert.equal(deriveShade('#4466e7', 2), '#0280a6')
  assert.equal(deriveShade('#ee2d35', 1), '#bc7001')
  assert.ok(deltaE('#4466e7', deriveShade('#4466e7', 1)) >= MIN_DISTANCE)
  assert.throws(() => deriveShade('#4466e7', 0), RangeError)
  console.log('deriveShade passed: stable and distinct from its base')
}

async function checkCandidateRoute(
  pool: ReturnType<typeof createPool>,
  databaseUrl: string,
  rows: Candidacy[],
) {
  const partisan = rows.filter((row) => row.abbreviation)
  const rival = (c: Candidacy) => (row: Candidacy) =>
    row.contest_id === c.contest_id && row.party_number !== c.party_number
  const a = partisan.find((c) => partisan.some(rival(c)))
  const b = a && partisan.find(rival(a))
  assert.ok(a && b, 'Expected a majoritarian contest with two parties')
  const dir = await mkdtemp(join(tmpdir(), 'datara-presentation-'))
  try {
    const file = join(dir, 'presentation.json')
    await writeFile(
      file,
      JSON.stringify({
        parties: { [a.party_number!]: { displayName: 'Local party', color: '#123456' } },
      }),
    )
    const app = await createApp(
      pool,
      readConfig({
        DATABASE_URL: databaseUrl,
        ELECTION_PRESENTATION_FILE: file,
        PHOTO_DIRECTORY: dir,
      }),
    )
    const response = await app.request(
      `/contests/${encodeURIComponent(a.contest_id)}/candidates?limit=100`,
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      items: { id: string; color: string; party: { displayName: string | null } | null }[]
    }
    const served = (row: Candidacy) => body.items.find((item) => item.id === row.id)
    assert.equal(served(a)?.party?.displayName, 'Local party')
    assert.equal(served(a)?.color, '#123456')
    assert.equal(served(b)?.party?.displayName, null)
    assert.equal(served(b)?.color, fallbackColor(b))
    console.log(
      `Candidate route passed: party.displayName and party/fallback colors served for ${a.contest_id}`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function checkActivePublication() {
  if (!process.env.DATABASE_URL)
    throw new Error(
      'DATABASE_URL is required: majoritarian colors are checked against the active publication',
    )
  const config = readConfig()
  const editorial = await readEditorial(config.presentationFile)
  const pool = createPool(config.databaseUrl)
  try {
    const { rows } = await pool.query<Candidacy>(
      `SELECT c.contest_id, c.id, c.number, c.display_name, c.party_number, p.abbreviation
       FROM editions e
       JOIN contests ct ON ct.publication_id = e.active_publication_id AND ct.vote_type = 'majoritarian'
       JOIN candidacies c ON c.publication_id = ct.publication_id AND c.contest_id = ct.id
       LEFT JOIN parties p ON p.publication_id = c.publication_id AND p.number = c.party_number
       WHERE e.id = $1`,
      [EDITION],
    )
    assert.ok(rows.length, 'No active publication with majoritarian contests; publish one first')
    rows.sort((a, b) => compare(a.contest_id, b.contest_id) || byNumber(a, b))
    await checkCandidateRoute(pool, config.databaseUrl, rows)
    const contests = new Map<string, Candidacy[]>()
    for (const row of rows) {
      if (!contests.has(row.contest_id)) contests.set(row.contest_id, [])
      contests.get(row.contest_id)!.push(row)
    }
    const problems: string[] = []
    const suggestions: string[] = []
    const parties = new Set<string>()
    let overrides = 0
    let nonPartisan = 0
    for (const [contest, list] of contests) {
      // Insertion order follows candidacy number; a later number yields to an earlier one.
      const colors = new Map<Candidacy, string>()
      for (const c of list) {
        const configured = configuredColor(editorial, c)
        const color = (configured ?? fallbackColor(c)).toLowerCase()
        if (editorial.candidates[c.id]?.color) overrides++
        if (color === NEUTRAL_COLOR)
          problems.push(
            `${label(c)}: resolves to ${NEUTRAL_COLOR}; set candidates["${c.id}"].color`,
          )
        // No party, or the empty party rows of a non-partisan contest: fallback palette, no rules.
        if (!c.abbreviation) {
          nonPartisan++
          continue
        }
        parties.add(c.party_number!)
        if (configured) colors.set(c, color)
        else problems.push(`${label(c)}: no configured color in parties["${c.party_number}"]`)
      }
      const ranked = [...colors.keys()]
      for (const [i, c] of ranked.entries()) {
        const earlier = ranked.slice(0, i)
        const clash = earlier.find((o) => deltaE(colors.get(o)!, colors.get(c)!) < MIN_DISTANCE)
        if (!clash) continue
        const distance = deltaE(colors.get(clash)!, colors.get(c)!)
        problems.push(
          `${label(c)}: ${colors.get(c)} ${distance ? `is ΔE ${distance.toFixed(3)} from` : 'equals'} ${clash.number} ${clash.display_name} (${clash.abbreviation})`,
        )
        // First shade from the party color, starting at the candidacy's rank within its party, that
        // stays apart from every other candidacy and keeps 3:1 against both themes.
        const sameParty = earlier.filter((o) => o.party_number === c.party_number)
        const base = editorial.parties[c.party_number!]?.color ?? colors.get(c)!
        const others = ranked.filter((o) => o !== c).map((o) => colors.get(o)!)
        const fits = (shade: string) =>
          others.every((o) => deltaE(o, shade) >= MIN_DISTANCE) &&
          SURFACES.every((surface) => contrast(shade, surface) >= 3)
        let k = Math.max(1, sameParty.length)
        while (k <= 8 && !fits(deriveShade(base, k))) k++
        if (k > 8) {
          problems.push(`${label(c)}: no derived shade fits; choose candidates["${c.id}"].color`)
          continue
        }
        const shade = deriveShade(base, k)
        colors.set(c, shade)
        const reason =
          clash.party_number === c.party_number
            ? `same party as ${sameParty[0]!.number}`
            : `ΔE ${distance.toFixed(3)} to ${clash.number} (${clash.abbreviation})`
        suggestions.push(
          `"${c.id}": { "color": "${shade}", "note": "${reason} in contest ${contest}; deriveShade k=${k}" },`,
        )
      }
    }
    const summary = `${contests.size} majoritarian contests, ${rows.length} candidacies (${nonPartisan} non-partisan on the fallback palette), ${overrides} candidate color overrides, ${parties.size} parties (${Object.keys(editorial.parties).length} configured)`
    if (problems.length) {
      console.error(`Active publication failed: ${summary}`)
      for (const problem of problems) console.error(`- ${problem}`)
      if (suggestions.length)
        console.log(`Suggested "candidates" entries:\n${suggestions.join('\n')}`)
      process.exitCode = 1
    } else
      console.log(
        `Active publication passed: ${summary}; every party configured, no two candidacies of a contest within ΔE ${MIN_DISTANCE}`,
      )
  } finally {
    await pool.end()
  }
}

await checkResolution()
await checkActivePublication()
