import type { Area, MapViewData } from '../../map/map-data'
import type { ApiClientError } from '../api-client'
import type { AreaResult, Candidate, Contest, ElectionMapResponse, MapResponse } from '../api-types'
import { titleCase } from '../format'

// Pure helpers of the results panel: modes, scope names, leaders, parties, navigation items.

export type CandidateRowData = AreaResult['candidates'][number]
export type PanelMode = 'summary' | 'ranking'

/** Summary (president, governor, senator) or ranking (deputies and the Noronha council). */
export function panelMode(contest: Pick<Contest, 'voteType' | 'seats'>): PanelMode {
  return contest.voteType === 'majoritarian' && (contest.seats ?? 1) <= 2 ? 'summary' : 'ranking'
}

/** Rows shown before "ver todos": the seats plus the first runner-up. */
export function topCount(contest: Pick<Contest, 'seats'>): number {
  return (contest.seats ?? 1) + 1
}

const STATE_AREA = /^[a-z]{2}$/

/** Name of the state of a mesh `stateAbbr` (upper case) or of an electoral `uf` (lower case). */
export function stateName(data: MapViewData | null, abbreviation: string): string | null {
  const upper = abbreviation.toUpperCase()
  return (
    data?.states.find((feature) => feature.properties.stateAbbr === upper)?.properties.name ?? null
  )
}

/** Name of a status scope: `br`, a state by the mesh, otherwise the result area itself. */
export function scopeName(data: MapViewData | null, areaId: string, result: AreaResult): string {
  if (areaId === 'br') return 'Brasil'
  if (STATE_AREA.test(areaId)) return stateName(data, areaId) ?? areaId.toUpperCase()
  if (areaId === result.area.id) return titleCase(result.area.name)
  return titleCase(result.area.name)
}

/** Label of the contest scope ("Brasil", the state or the municipality). */
export function contestScopeName(
  data: MapViewData | null,
  contest: Contest,
  area: Pick<AreaResult['area'], 'id' | 'name'> | null,
): string {
  if (contest.scopeAreaId === 'br') return 'Brasil'
  if (STATE_AREA.test(contest.scopeAreaId))
    return stateName(data, contest.scopeAreaId) ?? contest.scopeAreaId.toUpperCase()
  if (area && area.id === contest.scopeAreaId) return titleCase(area.name)
  return contest.scopeAreaId
}

export function leaderOf(result: AreaResult): CandidateRowData | null {
  const id = result.summary?.leaders[0]
  if (!id) return null
  return result.candidates.find((row) => row.candidate.id === id) ?? null
}

/** Party label of a candidate; the Noronha council carries empty party fields. */
export function partyLabel(party: Candidate['party']): string | null {
  if (!party) return null
  const label = party.displayName?.trim() || party.abbreviation.trim()
  return label || null
}

export type PartyInfo = { number: string; label: string }

/** Dictionary `partyNumber → label` from the candidate rows loaded so far. */
export function partiesOf(rows: readonly CandidateRowData[]): Map<string, PartyInfo> {
  const parties = new Map<string, PartyInfo>()
  for (const row of rows) {
    const party = row.candidate.party
    const label = partyLabel(party)
    if (party && label && !parties.has(party.number))
      parties.set(party.number, { number: party.number, label })
  }
  return parties
}

/** Share of the candidates outside the top N, only on the recorded-votes basis. */
export function othersShare(result: AreaResult, top: readonly CandidateRowData[]): number | null {
  const summary = result.summary
  if (
    !summary ||
    summary.shareBasis !== 'recordedCandidateVotesSum' ||
    summary.candidateVoteDenominator === null ||
    summary.candidateVoteDenominator <= 0 ||
    result.pagination.total <= top.length
  )
    return null
  let sum = 0
  for (const row of top) {
    if (row.votes === null) return null
    sum += row.votes
  }
  return ((summary.candidateVoteDenominator - sum) / summary.candidateVoteDenominator) * 100
}

export type NavigationLeader = { name: string; color: string; party: string | null }
export type NavigationItem = {
  area: Area
  leader: NavigationLeader | null
  /** Margin in percentage points. */
  margin: number | null
  /** `unknown`: no map for this office (names only). */
  status: 'available' | 'partial' | 'tie' | 'nodata' | 'unknown'
}

type AnyMap = MapResponse | ElectionMapResponse

/** Navigation rows for mesh areas, joined with a map response by `featureId`. */
export function navigationItems(areas: readonly Area[], map: AnyMap | null): NavigationItem[] {
  const byFeature = new Map<string, AnyMap['items'][number]>()
  if (map) for (const item of map.items) byFeature.set(item.featureId, item)
  return areas.map((area) => {
    if (!map) return { area, leader: null, margin: null, status: 'unknown' }
    const item = byFeature.get(area.id)
    if (!item || item.state !== 'available' || item.leaders.length === 0)
      return { area, leader: null, margin: null, status: 'nodata' }
    const candidate = map.candidates[item.leaders[0]]
    const leader: NavigationLeader | null = candidate
      ? {
          name: titleCase(candidate.displayName),
          color: candidate.color,
          party: partyLabel(candidate.party),
        }
      : null
    return {
      area,
      leader,
      margin: item.margin,
      status: item.tie ? 'tie' : !item.complete ? 'partial' : 'available',
    }
  })
}

const collator = new Intl.Collator('pt-BR')
export function byName<T extends { name: string }>(a: T, b: T): number {
  return collator.compare(a.name, b.name)
}

/** Message of the error card by client or API code. */
export function errorMessage(error: ApiClientError): string {
  if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT')
    return 'Não foi possível contatar a API de resultados.'
  if (error.status === 503) return 'Banco indisponível.'
  if (error.code === 'QUERY_TIMEOUT') return 'Recorte grande demais.'
  return error.message
}
