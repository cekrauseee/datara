import type { CountryCode } from '../map/map-countries'

// URL vocabulary of the elections collection on `/br`, additive to `?state=&municipality=`.
// Pure module: Node runs scripts/check-election-location.mjs on it directly, so it keeps
// type-only imports and no enums. Invalid values are ignored, never errors.

export const COLLECTIONS = ['elections'] as const
export type Collection = (typeof COLLECTIONS)[number]

export const OFFICES = [
  'president',
  'governor',
  'senator',
  'federal-deputy',
  'state-deputy',
  'district-deputy',
  'council',
] as const
export type OfficeKey = (typeof OFFICES)[number]

/** URL token ↔ TSE office code. */
export const OFFICE_CODES: Record<OfficeKey, string> = {
  president: '1',
  governor: '3',
  senator: '5',
  'federal-deputy': '6',
  'state-deputy': '7',
  'district-deputy': '8',
  council: '25',
}

/** Level of each office's contest scope; when that area changes, `candidate` is dropped. */
export const OFFICE_SCOPES: Record<OfficeKey, 'country' | 'state' | 'municipality'> = {
  president: 'country',
  governor: 'state',
  senator: 'state',
  'federal-deputy': 'state',
  'state-deputy': 'state',
  'district-deputy': 'state',
  council: 'municipality',
}

export const LEVELS = ['state', 'municipality'] as const
export type Level = (typeof LEVELS)[number]

export const METRICS = ['leader', 'margin', 'turnout', 'votes', 'share', 'contribution'] as const
export type Metric = (typeof METRICS)[number]
/** Metrics that only exist for a candidate; without `candidate` they fall back to the default. */
export const CANDIDATE_METRICS: readonly Metric[] = ['votes', 'share', 'contribution']

export const ELECTION_PARAMETERS = [
  'collection',
  'office',
  'level',
  'metric',
  'candidate',
  'zone',
  'section',
  'area',
  'publication',
  'round',
] as const
export type ElectionParameter = (typeof ELECTION_PARAMETERS)[number]

export type ElectionState = {
  collection: Collection | null
  office: OfficeKey | null
  level: Level
  metric: Metric
  /** Candidate `officialId` (TSE sqcand). */
  candidate: string | null
  zone: string | null
  section: string | null
  /**
   * Electoral area outside the IBGE mesh: `exterior`, `zz:NNNNN` or `region:x`, verbatim. An
   * exterior locality (`zz:NNNNN`) keeps `zone` and `section` like a municipality.
   */
  area: string | null
  /** Publication UUID, read only; never written by the explorer. */
  publication: string | null
  /** Reserved: absent means the first round. Never introduced by the explorer. */
  round: 1 | 2
  warnings: string[]
}

export type ElectionPatch = Partial<
  Pick<
    ElectionState,
    'collection' | 'office' | 'level' | 'metric' | 'candidate' | 'zone' | 'section' | 'area'
  >
>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AREA = /^(exterior|zz:\d{5}|region:[a-z]+)$/
/** Exterior locality: municipality-like, it has zones and sections of its own. */
const LOCALITY = /^zz:\d{5}$/
const CODE = /^\d{4}$/
const DIGITS = /^\d+$/
const STATE = /^\d{2}$/
const MUNICIPALITY = /^\d{7}$/

export function isOffice(value: unknown): value is OfficeKey {
  return typeof value === 'string' && (OFFICES as readonly string[]).includes(value)
}
export function isMetric(value: unknown): value is Metric {
  return typeof value === 'string' && (METRICS as readonly string[]).includes(value)
}
export function defaultMetric(candidate: string | null): Metric {
  return candidate ? 'share' : 'leader'
}

function readCountry(url: URL, basePath: string): CountryCode {
  return url.pathname.slice(basePath.length).replace(/\/$/, '') === 'us' ? 'US' : 'BR'
}

const subDefaults = {
  office: null,
  level: 'municipality',
  metric: 'leader',
  candidate: null,
  zone: null,
  section: null,
  area: null,
} satisfies Partial<ElectionState>

export function readElection(url: URL, basePath = '/'): ElectionState {
  const params = url.searchParams
  const brazil = readCountry(url, basePath) === 'BR'
  const publicationValue = params.get('publication')
  const publication =
    brazil && publicationValue && UUID.test(publicationValue) ? publicationValue : null
  const round = brazil && params.get('round') === '2' ? 2 : 1
  const collection = brazil && params.get('collection') === 'elections' ? 'elections' : null
  if (!collection) return { collection: null, ...subDefaults, publication, round, warnings: [] }

  const warnings: string[] = []
  const officeValue = params.get('office')
  const office = isOffice(officeValue) ? officeValue : null
  const level: Level = params.get('level') === 'state' ? 'state' : 'municipality'
  const areaValue = params.get('area')
  const area = areaValue && AREA.test(areaValue) ? areaValue : null
  const hasMunicipality = area
    ? LOCALITY.test(area)
    : MUNICIPALITY.test(params.get('municipality') ?? '')
  const zoneValue = params.get('zone')
  let zone = zoneValue && CODE.test(zoneValue) ? zoneValue : null
  if (zone && !hasMunicipality) {
    zone = null
    warnings.push('A zona eleitoral exige um município selecionado e foi ignorada.')
  }
  const sectionValue = params.get('section')
  let section = sectionValue && CODE.test(sectionValue) ? sectionValue : null
  if (section && !zone) {
    section = null
    warnings.push('A seção eleitoral exige uma zona e foi ignorada.')
  }
  const candidateValue = params.get('candidate')
  let candidate: string | null = null
  if (candidateValue === '') warnings.push('O parâmetro de candidato estava vazio e foi removido.')
  else if (candidateValue && DIGITS.test(candidateValue)) candidate = candidateValue
  const metricValue = params.get('metric')
  let metric = isMetric(metricValue) ? metricValue : defaultMetric(candidate)
  if (!candidate && CANDIDATE_METRICS.includes(metric)) metric = 'leader'
  return {
    collection,
    office,
    level,
    metric,
    candidate,
    zone,
    section,
    area,
    publication,
    round,
    warnings,
  }
}

// Dependency rules shared by the reader and the writer.
function consistent(state: ElectionState, hasMunicipality: boolean): ElectionState {
  const next = { ...state }
  if (!next.collection) Object.assign(next, subDefaults)
  if (!hasMunicipality) next.zone = next.section = null
  if (!next.zone) next.section = null
  if (!next.candidate && CANDIDATE_METRICS.includes(next.metric)) next.metric = 'leader'
  return next
}

/** Reserializes only the valid state; `area` prevails over the IBGE selection. */
export function writeElection(url: URL, state: ElectionState): void {
  const params = url.searchParams
  for (const parameter of ELECTION_PARAMETERS) params.delete(parameter)
  if (state.area) {
    params.delete('state')
    params.delete('municipality')
  }
  const next = consistent(
    state,
    state.area ? LOCALITY.test(state.area) : MUNICIPALITY.test(params.get('municipality') ?? ''),
  )
  if (next.collection) params.set('collection', next.collection)
  if (next.office) params.set('office', next.office)
  if (next.level !== 'municipality') params.set('level', next.level)
  if (next.metric !== defaultMetric(next.candidate)) params.set('metric', next.metric)
  if (next.candidate) params.set('candidate', next.candidate)
  if (next.zone) params.set('zone', next.zone)
  if (next.section) params.set('section', next.section)
  if (next.area) params.set('area', next.area)
  if (next.publication) params.set('publication', next.publication)
  if (next.round !== 1) params.set('round', String(next.round))
}

/**
 * Election navigation: applies the patch and the clearing rules (changing the collection drops its
 * sub-parameters; changing the office drops `candidate`) and returns `pathname + search + hash`.
 */
export function electionURL(url: URL, patch: ElectionPatch, basePath = '/'): string {
  const next = new URL(url)
  const previous = readElection(url, basePath)
  const state: ElectionState = { ...previous, warnings: [] }
  if (patch.collection !== undefined && patch.collection !== previous.collection)
    Object.assign(state, subDefaults, { collection: patch.collection })
  if (patch.office !== undefined) state.office = patch.office
  if (patch.level !== undefined) state.level = patch.level
  if (patch.metric !== undefined) state.metric = patch.metric
  if (patch.candidate !== undefined) state.candidate = patch.candidate
  if (patch.zone !== undefined) state.zone = patch.zone
  if (patch.section !== undefined) state.section = patch.section
  if (patch.area !== undefined) state.area = patch.area
  // Zones and sections belong to the area they were chosen in (a municipality or a locality).
  if (state.area !== previous.area && patch.zone === undefined) state.zone = state.section = null
  if (state.zone !== previous.zone && patch.section === undefined) state.section = null
  if (state.office !== previous.office && patch.candidate === undefined) state.candidate = null
  writeElection(next, state)
  return `${next.pathname}${next.search}${next.hash}`
}

export type SelectionChange = { countryCode: CountryCode; previousSelectionId: string | null }

function selectionCodes(selectionId: string | null) {
  if (selectionId && MUNICIPALITY.test(selectionId))
    return { state: selectionId.slice(0, 2), municipality: selectionId }
  if (selectionId && STATE.test(selectionId)) return { state: selectionId, municipality: null }
  return { state: null, municipality: null }
}

/**
 * Geographic navigation, applied after `locationURL` wrote `state`/`municipality`: outside Brazil
 * every election parameter goes; an IBGE selection removes `area`; changing or losing the
 * municipality removes `zone` and `section`; changing the contest scope area removes `candidate`.
 */
export function clearElectionParameters(next: URL, change: SelectionChange, basePath = '/'): void {
  const params = next.searchParams
  if (change.countryCode !== 'BR') {
    for (const parameter of ELECTION_PARAMETERS) params.delete(parameter)
    return
  }
  const previous = selectionCodes(change.previousSelectionId)
  const current = { state: params.get('state'), municipality: params.get('municipality') }
  if (current.state || current.municipality) params.delete('area')
  if (current.municipality !== previous.municipality) {
    params.delete('zone')
    params.delete('section')
  }
  const state = readElection(next, basePath)
  if (state.office) {
    const scope = OFFICE_SCOPES[state.office]
    if (
      (scope === 'state' && current.state !== previous.state) ||
      (scope === 'municipality' && current.municipality !== previous.municipality)
    )
      state.candidate = null
  }
  writeElection(next, state)
}

/** Removes the election parameters from a `pathname + search + hash` location. */
export function withoutElectionParameters(location: string): string {
  const url = new URL(location, 'http://localhost')
  if (!ELECTION_PARAMETERS.some((parameter) => url.searchParams.has(parameter))) return location
  for (const parameter of ELECTION_PARAMETERS) url.searchParams.delete(parameter)
  return `${url.pathname}${url.search}${url.hash}`
}
