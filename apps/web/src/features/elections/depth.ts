import type { AreaLevel, AreaResult, ElectoralArea } from './api-types'
import type { OfficeKey } from './election-location'

// Electoral depth below the IBGE mesh: zones and sections of a municipality, the exterior and its
// localities, and the regions. Pure module (type-only imports): Node runs
// scripts/check-election-depth-rules.mjs on it directly.

export type DepthKind = 'exterior' | 'locality' | 'region'

/** Kind of an `area` URL value, or `null` for anything else. */
export function areaKind(areaId: string | null): DepthKind | null {
  if (areaId === 'exterior') return 'exterior'
  if (areaId && /^zz:\d{5}$/.test(areaId)) return 'locality'
  if (areaId && /^region:[a-z]+$/.test(areaId)) return 'region'
  return null
}

/** Display order of the national rows: the five regions, then the exterior. */
export const REGION_ORDER = [
  'region:north',
  'region:northeast',
  'region:centralwest',
  'region:southeast',
  'region:south',
] as const

/**
 * Portuguese names for the region IDs. The active publication names regions with these English
 * IDs (`north`…); any other name from the API is used as it comes.
 */
const REGION_NAMES: Record<string, string> = {
  north: 'Norte',
  northeast: 'Nordeste',
  centralwest: 'Centro-Oeste',
  southeast: 'Sudeste',
  south: 'Sul',
}

export function regionName(area: Pick<ElectoralArea, 'id' | 'name'> | string): string {
  const id = typeof area === 'string' ? area : area.id
  const name = typeof area === 'string' ? null : area.name
  const suffix = id.replace(/^region:/, '')
  if (!name || name === suffix || name in REGION_NAMES) return REGION_NAMES[suffix] ?? suffix
  return name
}

/** Only president has results outside the domestic states (regions and exterior). */
export function areaAllowed(office: OfficeKey | null): boolean {
  return office === 'president'
}

export const AREA_OFFICE_NOTICE = 'Exterior e regiões só têm resultados para presidente.'

export function zoneNotFound(zone: string, where: DepthKind | 'municipality'): string {
  return `Zona ${zone} não encontrada ${where === 'locality' ? 'nesta localidade' : 'neste município'}.`
}
export function sectionNotFound(section: string, zone: string): string {
  return `Seção ${section} não encontrada na Zona ${zone}.`
}

/** Item of a `/areas` page matching a zone or section code (the API filters by `q`). */
export function findByCode(
  items: readonly ElectoralArea[],
  level: 'zone' | 'section',
  code: string,
): ElectoralArea | null {
  return (
    items.find((item) => (level === 'zone' ? item.zoneCode === code : item.sectionCode === code)) ??
    null
  )
}

/** Section code of the principal of an aggregated section, from the items loaded so far. */
export function principalCode(
  items: Iterable<ElectoralArea>,
  principalAreaId: string | null,
): string | null {
  if (!principalAreaId) return null
  for (const item of items) if (item.id === principalAreaId) return item.sectionCode
  return null
}

/** Child level listed below an area, or `null` (a section has nothing below). */
export function childLevel(area: Pick<ElectoralArea, 'id' | 'level'>): AreaLevel | null {
  if (area.id === 'exterior') return 'municipality'
  if (area.level === 'region') return 'state'
  if (area.level === 'municipality') return 'zone'
  if (area.level === 'zone') return 'section'
  return null
}

/**
 * Level of a candidate's distribution below an area (module 6): zone in a municipality or
 * locality, section in a zone, locality in the exterior, state in a region, never in a section.
 */
export const distributionLevel = childLevel

/** "7/7" from an aggregate's `provenance.meaning` ("… (7/7 states); exterior excluded"). */
export function aggregateCoverage(meaning: string | null | undefined): string | null {
  const match = meaning?.match(/\((\d+)\s*\/\s*(\d+)\s+states?\)/)
  return match ? `${match[1]}/${match[2]}` : null
}

/**
 * A BU `generatedAt` has no offset: it is the ballot box's local clock, shown as written
 * ("04/10/2026 17:10"). Values with an offset return `null` (formatted elsewhere).
 */
export function localClock(value: string | null | undefined): string | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/)
  return match ? `${match[3]}/${match[2]}/${match[1]} ${match[4]}:${match[5]}` : null
}

/** API codes for a combination the UI never asks for: shown once, without retry. */
const COMBINATION_CODES = new Set(['LEVEL_TOO_DEEP', 'LEVEL_NOT_BELOW_SCOPE', 'INCOMPATIBLE_AREA'])
export function isCombinationError(error: { code: string } | null): boolean {
  return !!error && COMBINATION_CODES.has(error.code)
}

export type PrintedTotal = { label: string; value: number | null; note?: string }

/**
 * Printed totals of a ballot-box report (BU): nominal, legend, blank, null and "no candidate" sum
 * to `totalVotes`; `validVotes` does not exist in a BU.
 */
export function printedTotals(totals: NonNullable<AreaResult['totals']>): PrintedTotal[] {
  return [
    { label: 'Nominais', value: totals.nominalVotes },
    { label: 'Legenda', value: totals.legendVotes },
    { label: 'Brancos', value: totals.blankVotes },
    { label: 'Nulos', value: totals.nullVotes },
    {
      label: 'Sem candidato',
      value: totals.noCandidateVotes,
      note: totals.noCandidateVotes === null ? 'não registrado nesta publicação' : undefined,
    },
  ]
}

/** Sum of the printed totals when every part is known, else `null`. */
export function printedSum(entries: readonly PrintedTotal[]): number | null {
  let sum = 0
  for (const entry of entries) {
    if (entry.value === null) return null
    sum += entry.value
  }
  return sum
}

/** "N votáveis sem candidatura verificada: nº 55 (1 voto)". */
export function unresolvedNote(votables: AreaResult['unresolvedVotables']): string | null {
  if (votables.length === 0) return null
  const list = votables
    .map((item) => `nº ${item.number} (${item.votes} ${item.votes === 1 ? 'voto' : 'votos'})`)
    .join(', ')
  return `${votables.length} ${votables.length === 1 ? 'votável' : 'votáveis'} sem candidatura verificada: ${list}`
}

/** The leader cannot be determined when unresolved printed votes could change the order. */
export function undetermined(result: Pick<AreaResult, 'summary'>): boolean {
  const summary = result.summary
  if (!summary) return false
  return (
    summary.leaders.length === 0 ||
    (summary.margin.votes === null && summary.margin.basis === 'unresolvedPrintedCandidateVotes')
  )
}
