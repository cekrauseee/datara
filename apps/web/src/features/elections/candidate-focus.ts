// Pure rules of the candidate focus: votes of the candidate in an area, support (apoio) and
// contribution with their bases and the reasons a value is unavailable, and the Portuguese labels.
// Type-only imports, so the Node check can load this module.
import type {
  AreaLevel,
  AreaResult,
  DistributionLevel,
  DistributionResponse,
  ElectoralArea,
} from './api-types'
import { MISSING, titleCase } from './format'

export type SourceKind = 'EA20' | 'BU' | 'aggregate'

/** Distribution level listed below an area; regions, sections and others have none. */
export const LEVEL_BELOW: Partial<Record<AreaLevel, NonNullable<DistributionLevel>>> = {
  country: 'state',
  state: 'municipality',
  municipality: 'zone',
  zone: 'section',
}

/** `aggregate` (sum of states) is official totalization and compares as `EA20`. */
export function comparableKind(kind: SourceKind | null | undefined): 'EA20' | 'BU' | null {
  if (!kind) return null
  return kind === 'aggregate' ? 'EA20' : kind
}

export type FocusMeasure = {
  value: number | null
  numerator: number | null
  denominator: number | null
  basis: string
  state: 'available' | 'unavailable' | 'undefined'
  /** Why the value is missing, in Portuguese; `null` when available. */
  reason: string | null
}

/** The candidate's votes in one area, with the data needed to compare it with another area. */
export type AreaVotes = {
  area: ElectoralArea
  resultState: AreaResult['state']
  sourceKind: SourceKind | null
  complete: boolean
  votes: number | null
  /** `summary.candidateVoteDenominator` of the area and its basis. */
  denominator: number | null
  shareBasis: string | null
  /** The `share` of the candidate's `/results` row when it was on the loaded page. */
  rowShare: AreaResult['candidates'][number]['share'] | null
}

/** The `/results` row lacks the candidate and the votes must come from `/distribution`. */
export function needsDistribution(result: AreaResult, candidateId: string): boolean {
  return (
    result.state === 'available' &&
    !result.candidates.some((row) => row.candidate.id === candidateId) &&
    LEVEL_BELOW[result.area.level] !== undefined
  )
}

/**
 * Votes of the candidate in the result's area: the `/results` row when it is on the loaded page,
 * otherwise `contribution.denominator` of the first `/distribution` item below the area (the API's
 * votes of the candidate in the selected scope); an empty list means unavailable.
 */
export function areaVotes(
  result: AreaResult,
  candidateId: string,
  distribution: DistributionResponse | null,
): AreaVotes {
  const row = result.candidates.find((item) => item.candidate.id === candidateId) ?? null
  let votes: number | null = null
  if (result.state === 'available')
    votes = row ? row.votes : (distribution?.items[0]?.contribution.denominator ?? null)
  return {
    area: result.area,
    resultState: result.state,
    sourceKind: result.provenance?.sourceKind ?? null,
    complete: result.complete,
    votes,
    denominator: result.summary?.candidateVoteDenominator ?? null,
    shareBasis: result.summary?.shareBasis ?? null,
    rowShare: row?.share ?? null,
  }
}

function unavailable(basis: string, reason: string): FocusMeasure {
  return { value: null, numerator: null, denominator: null, basis, state: 'unavailable', reason }
}

function missingReason(area: AreaVotes): string | null {
  if (area.resultState === 'shared') return 'Contados junto com a seção principal.'
  if (area.resultState === 'unavailable' || area.votes === null)
    return `Sem resultado ${inArea(area.area)} nesta publicação.`
  return null
}

/** Support: votes in the area over `candidateVoteDenominator`, equal to the row's `share`. */
export function supportOf(area: AreaVotes): FocusMeasure {
  const basis = area.rowShare?.basis ?? area.shareBasis ?? 'recordedCandidateVotesSum'
  const reason = missingReason(area)
  if (reason) return unavailable(basis, reason)
  if (area.rowShare && area.rowShare.state === 'available')
    return { ...area.rowShare, reason: null }
  const denominator = area.denominator
  if (denominator === null) return unavailable(basis, 'A fonte não publica a base desta área.')
  if (denominator === 0)
    return {
      value: null,
      numerator: area.votes,
      denominator,
      basis,
      state: 'undefined',
      reason: 'Nenhum voto nominal nesta área.',
    }
  return {
    value: (area.votes! / denominator) * 100,
    numerator: area.votes,
    denominator,
    basis,
    state: 'available',
    reason: null,
  }
}

export const CONTRIBUTION_BASIS = 'candidateVotesInSelectedScope'

/**
 * Contribution of the area to the candidate's votes in an enclosing area (`territorialItem`'s
 * rule): available only when both have a result and their source kinds match.
 */
export function contributionOf(area: AreaVotes, parent: AreaVotes): FocusMeasure {
  const own = missingReason(area)
  if (own) return unavailable(CONTRIBUTION_BASIS, own)
  if (parent.resultState !== 'available' || parent.votes === null)
    return unavailable(CONTRIBUTION_BASIS, `Sem resultado ${inArea(parent.area)} nesta publicação.`)
  const here = comparableKind(area.sourceKind)
  const there = comparableKind(parent.sourceKind)
  if (here !== there)
    return unavailable(
      CONTRIBUTION_BASIS,
      `Aqui ${sourceName(area.sourceKind)}, ${inArea(parent.area)} ${sourceName(parent.sourceKind)}; a API não compara as duas.`,
    )
  if (parent.votes === 0)
    return {
      value: null,
      numerator: area.votes,
      denominator: 0,
      basis: CONTRIBUTION_BASIS,
      state: 'undefined',
      reason: `Sem votos da candidatura ${inArea(parent.area)}.`,
    }
  return {
    value: (area.votes! / parent.votes) * 100,
    numerator: area.votes,
    denominator: parent.votes,
    basis: CONTRIBUTION_BASIS,
    state: 'available',
    reason: null,
  }
}

const SOURCE_NAMES: Record<SourceKind, string> = {
  EA20: 'totalização',
  aggregate: 'totalização',
  BU: 'boletim de urna',
}

function sourceName(kind: SourceKind | null) {
  return kind ? SOURCE_NAMES[kind] : 'sem fonte'
}

const FOCUS_BASIS_LABELS: Record<string, string> = {
  [CONTRIBUTION_BASIS]: 'dos votos do candidato no escopo',
  incompatibleOrUnavailableSourceBases: 'indisponível',
}

/** Labels of the distribution bases not covered by `basisLabel`. */
export function focusBasisLabel(basis: string, fallback: (basis: string) => string): string {
  return FOCUS_BASIS_LABELS[basis] ?? fallback(basis)
}

/** "50,95%": two decimals, for small contributions; "<0,01%" for positive values below that. */
const twoDecimals = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
export function formatFocusPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MISSING
  // A positive share that rounds to zero is not zero.
  if (value > 0 && value < 0.005) return '<0,01%'
  return `${twoDecimals.format(value)}%`
}
// Articles of the states (and the country) for "no Acre", "na Bahia", "em Pernambuco".
const ARTICLES: Record<string, 'o' | 'a' | ''> = {
  br: 'o',
  exterior: 'o',
  ac: 'o',
  al: '',
  ap: 'o',
  am: 'o',
  ba: 'a',
  ce: 'o',
  df: 'o',
  es: 'o',
  go: '',
  ma: 'o',
  mt: '',
  ms: '',
  mg: '',
  pa: 'o',
  pb: 'a',
  pr: 'o',
  pe: '',
  pi: 'o',
  rj: 'o',
  rn: 'o',
  rs: 'o',
  ro: '',
  rr: '',
  sc: '',
  sp: '',
  se: '',
  to: 'o',
}

type NamedArea = Pick<ElectoralArea, 'id' | 'level' | 'name'>

function article(area: NamedArea): 'o' | 'a' | '' {
  if (area.level === 'zone' || area.level === 'section') return 'a'
  if (area.level === 'country' || area.level === 'state') return ARTICLES[area.id] ?? ''
  return ''
}

/** Display name: upper-case source names in title case. */
export function areaName(area: NamedArea): string {
  return area.id === 'br' ? 'Brasil' : titleCase(area.name)
}

/** "no Acre", "na Bahia", "em Porto Walter", "na Zona 0004". */
export function inArea(area: NamedArea): string {
  const name = areaName(area)
  const value = article(area)
  return value === 'o' ? `no ${name}` : value === 'a' ? `na ${name}` : `em ${name}`
}

/** "para o Acre", "para a Bahia", "para Porto Walter". */
export function toArea(area: NamedArea): string {
  const name = areaName(area)
  const value = article(area)
  return value ? `para ${value} ${name}` : `para ${name}`
}

/** "Lula (13 · PT)", without the party for council candidacies. */
export function candidateTitle(
  candidate: {
    displayName: string
    number: string
    party: { abbreviation: string } | null
  },
  name: string,
): string {
  return `${name} (${candidate.number}${candidate.party ? ` · ${candidate.party.abbreviation}` : ''})`
}

/**
 * Parent of an area for the contribution: country ← state ← municipality ← zone ← section.
 * States, the exterior and regions belong to the country (a state's `parentId` is its region).
 */
export function parentAreaId(area: ElectoralArea): string | null {
  if (area.level === 'country') return null
  if (area.level === 'region' || area.level === 'state') return 'br'
  return area.parentId
}
