import type { Contest, MapLevel, MapMetric, OfficeMapMetric } from './api-types'
import {
  CANDIDATE_METRICS,
  OFFICES,
  OFFICE_CODES,
  type Level,
  type Metric,
  type OfficeKey,
} from './election-location'

/** The edition is resolved by query, never by a fixed ID; `round` comes from the URL. */
export const EDITION = { country: 'BR', year: 2026 } as const

export const OFFICE_NAMES: Record<OfficeKey, string> = {
  president: 'Presidente',
  governor: 'Governador',
  senator: 'Senador',
  'federal-deputy': 'Deputado federal',
  'state-deputy': 'Deputado estadual',
  'district-deputy': 'Deputado distrital',
  council: 'Conselho distrital',
}

export const OFFICE_BY_CODE: ReadonlyMap<string, OfficeKey> = new Map(
  OFFICES.map((office) => [OFFICE_CODES[office], office]),
)

/** Offices with leader and margin maps; the others only map turnout or a focused candidate. */
export const MAJORITARIAN_OFFICES: ReadonlySet<OfficeKey> = new Set([
  'president',
  'governor',
  'senator',
])

/** URL metric token → API metric. */
export const API_METRICS: Record<Metric, MapMetric> = {
  leader: 'leader',
  margin: 'margin',
  turnout: 'turnout',
  votes: 'candidateVotes',
  share: 'candidateShare',
  contribution: 'contribution',
}

export type ContestIndex = ReadonlyMap<string, readonly Contest[]>

/** Contests by `officeCode`, built once per publication. */
export function indexContests(contests: readonly Contest[]): ContestIndex {
  const index = new Map<string, Contest[]>()
  for (const contest of contests) {
    const list = index.get(contest.officeCode)
    if (list) list.push(contest)
    else index.set(contest.officeCode, [contest])
  }
  return index
}

function isIndex(contests: readonly Contest[] | ContestIndex): contests is ContestIndex {
  return !Array.isArray(contests)
}

function ofOffice(contests: readonly Contest[] | ContestIndex, office: OfficeKey) {
  const code = OFFICE_CODES[office]
  return isIndex(contests)
    ? (contests.get(code) ?? [])
    : contests.filter((contest) => contest.officeCode === code)
}

/** A contest scope covers an area when it is `br`, the area itself or one of its ancestors. */
export function contestCovers(scopeAreaId: string, areaId: string): boolean {
  return scopeAreaId === 'br' || scopeAreaId === areaId || areaId.startsWith(`${scopeAreaId}:`)
}

/** The office's contest whose scope is the closest ancestor-or-self of the area. */
export function deriveContest(
  contests: readonly Contest[] | ContestIndex,
  office: OfficeKey,
  areaId: string,
): Contest | null {
  let best: Contest | null = null
  for (const contest of ofOffice(contests, office))
    if (
      contestCovers(contest.scopeAreaId, areaId) &&
      (!best || contest.scopeAreaId.length > best.scopeAreaId.length)
    )
      best = contest
  return best
}

/** In the national view, offices contested per state (two or more contests) use the cross map. */
export function isNationalOffice(
  contests: readonly Contest[] | ContestIndex,
  office: OfficeKey,
  areaId: string,
): boolean {
  return (
    areaId === 'br' &&
    !deriveContest(contests, office, areaId) &&
    ofOffice(contests, office).length >= 2
  )
}

export type OfficeAvailability = { office: OfficeKey; contest: Contest | null; national: boolean }

/** Offices selectable for an area, in display order. */
export function availableOffices(
  contests: readonly Contest[] | ContestIndex,
  areaId: string,
): OfficeAvailability[] {
  const index = isIndex(contests) ? contests : indexContests(contests)
  return OFFICES.flatMap((office): OfficeAvailability[] => {
    const contest = deriveContest(index, office, areaId)
    if (contest) return [{ office, contest, national: false }]
    if (isNationalOffice(index, office, areaId)) return [{ office, contest: null, national: true }]
    return []
  })
}

const MUNICIPAL_AREA = /^[a-z]{2}:\d{5}$/

/** Appends zone and section to a municipal electoral area ID. */
export function specificAreaId(baseAreaId: string, zone: string | null, section: string | null) {
  if (!zone || !MUNICIPAL_AREA.test(baseAreaId)) return baseAreaId
  return section ? `${baseAreaId}:${zone}:${section}` : `${baseAreaId}:${zone}`
}

export type ContestMapRequest = {
  kind: 'contest'
  contestId: string
  level: MapLevel
  metric: MapMetric
  candidateId?: string
  /** Only for `contribution`: the scope from `contributionMapScope`. */
  areaId?: string
}
export type OfficeMapRequest = {
  kind: 'office'
  officeCode: string
  level: MapLevel
  metric: OfficeMapMetric
}
export type MapRequest = ContestMapRequest | OfficeMapRequest

/**
 * Scope of a contribution map: the closest area enclosing the selection whose children are drawn
 * at the map grain, so a municipality (or a zone or section) is compared with its siblings in the
 * state instead of filling one polygon at 100 %. Never wider than the contest's scope.
 */
export function contributionMapScope(contestScopeId: string, areaId: string, level: MapLevel) {
  let scope: string
  if (areaId === 'br' || areaId.startsWith('region:')) scope = areaId
  else if (level === 'state') scope = 'br'
  else if (areaId === 'exterior' || areaId.startsWith('zz:')) scope = 'exterior'
  else scope = areaId.split(':')[0]
  return contestCovers(contestScopeId, scope) ? scope : contestScopeId
}

const OFFICE_MAP_METRICS: ReadonlySet<MapMetric> = new Set(['leader', 'margin', 'turnout'])

/**
 * Map slot for the current state. Candidate metrics wait for the candidate; offices without a
 * leader map (deputies, council) only map turnout or a candidate; the national view of a
 * per-state office uses the cross map by office.
 */
export function deriveMapRequest(input: {
  office: OfficeKey
  contest: Contest | null
  national: boolean
  level: Level
  metric: Metric
  candidateId: string | null
  candidatePending: boolean
  areaId: string
}): MapRequest | null {
  const { office, contest, level } = input
  const majoritarian = MAJORITARIAN_OFFICES.has(office)
  if (contest) {
    const needsCandidate = CANDIDATE_METRICS.includes(input.metric)
    if (needsCandidate && input.candidatePending) return null
    const metric: MapMetric =
      needsCandidate && !input.candidateId ? 'leader' : API_METRICS[input.metric]
    const withCandidate = needsCandidate && !!input.candidateId
    if (!majoritarian && !withCandidate && metric !== 'turnout') return null
    return {
      kind: 'contest',
      contestId: contest.id,
      level,
      metric,
      ...(withCandidate ? { candidateId: input.candidateId! } : {}),
      ...(metric === 'contribution'
        ? { areaId: contributionMapScope(contest.scopeAreaId, input.areaId, level) }
        : {}),
    }
  }
  if (!input.national) return null
  const metric = API_METRICS[input.metric]
  if (!majoritarian && metric !== 'turnout') return null
  return {
    kind: 'office',
    officeCode: OFFICE_CODES[office],
    level,
    metric: OFFICE_MAP_METRICS.has(metric) ? (metric as OfficeMapMetric) : 'leader',
  }
}
