// Portuguese (Brazil) formatting and labels for the results panel. Every value may be `null`
// (not published by the source) and renders as an em dash, never as zero.

export const MISSING = '—'

const integer = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 })
const oneDecimal = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})
const twoDecimals = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const dateTime = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
})

export function formatInteger(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? integer.format(value) : MISSING
}

/**
 * "64,6%": one decimal, no space before the sign. With `fine`, values below 1 % keep two decimals
 * ("0,25%"), for small shares such as a municipality's contribution to a candidacy.
 */
export function formatPercent(
  value: number | null | undefined,
  { fine = false }: { fine?: boolean } = {},
): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MISSING
  return `${(fine && Math.abs(value) < 1 ? twoDecimals : oneDecimal).format(value)}%`
}

/** "1,9 p.p." */
export function formatPoints(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${oneDecimal.format(value)} p.p.`
    : MISSING
}

/** "123.456 votos", "1 voto". */
export function formatVotes(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MISSING
  return `${integer.format(value)} ${value === 1 ? 'voto' : 'votos'}`
}

/** Short date and time in São Paulo; invalid or missing values render as the dash. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return MISSING
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? MISSING : dateTime.format(date)
}

/** Percentage of `part` over `whole`, or `null` when either is missing. */
export function ratio(part: number | null | undefined, whole: number | null | undefined) {
  return typeof part === 'number' && typeof whole === 'number' && whole > 0
    ? (part / whole) * 100
    : null
}

const BASIS_LABELS: Record<string, string> = {
  recordedCandidateVotesSum: 'dos votos nominais registrados',
  printedNominalVotes: 'dos votos nominais impressos (BU)',
  eligibleElectors: 'do eleitorado',
  unresolvedPrintedCandidateVotes: 'indeterminado',
}

/** Human label of a share or margin basis; unknown bases are shown verbatim. */
export function basisLabel(basis: string | null | undefined): string {
  if (!basis) return ''
  return BASIS_LABELS[basis] ?? basis
}

const SOURCE_KIND_LABELS: Record<string, string> = {
  EA20: 'totalização oficial',
  BU: 'boletim de urna',
  aggregate: 'soma de UFs',
}

export function sourceKindLabel(kind: string | null | undefined): string {
  if (!kind) return 'fonte não informada'
  return SOURCE_KIND_LABELS[kind] ?? kind
}

const PARTICLES = new Set(['da', 'de', 'do', 'das', 'dos', 'e'])
const VOWELS = /[aeiouáéíóúâêôãõà]/i

function titleWord(word: string, first: boolean): string {
  const lower = word.toLocaleLowerCase('pt-BR')
  if (!first && PARTICLES.has(lower)) return lower
  // Short consonant-only words are acronyms or nicknames (JHC) and keep their case.
  if (word.length <= 4 && !VOWELS.test(word)) return word
  return lower.replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase('pt-BR'))
}

/**
 * Names arrive in upper case from the source; strings that already carry lower-case letters are
 * editorial and stay as they are. Particles (da, de, do, das, dos, e) stay lower case.
 */
export function titleCase(name: string | null | undefined): string {
  if (!name) return ''
  if (/\p{Ll}/u.test(name)) return name
  return name
    .split(/(\s+|-)/)
    .map((part, index, parts) =>
      /^(\s+|-)$/.test(part) || part === ''
        ? part
        : titleWord(
            part,
            parts.slice(0, index).every((previous) => /^(\s*|-)$/.test(previous)),
          ),
    )
    .join('')
}

/** First and last word initials for the photo fallback. */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '')
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0].charAt(0)
  const last = words.length > 1 ? words[words.length - 1].charAt(0) : ''
  return `${first}${last}`.toLocaleUpperCase('pt-BR')
}
