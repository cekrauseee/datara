import type { z } from '@hono/zod-openapi'
import type { ResultStatus } from './contracts.js'

type Status = z.output<typeof ResultStatus>

const labels: Record<Status, string> = {
  notStarted: 'Totalização não iniciada',
  inProgress: 'Totalização em andamento',
  finished: 'Totalização finalizada',
  printed: 'Boletim de urna impresso',
  regionComplete: 'Soma das UFs completa',
  regionPartial: 'Soma das UFs parcial',
  unknown: 'Situação oficial desconhecida',
}
// Stored codes per source: the EA20 totalization status `and` (n, p, f), the fixed BU status and
// the completeness of a region's sum of state results.
const codes: Record<string, Record<string, Status>> = {
  EA20: { n: 'notStarted', p: 'inProgress', f: 'finished' },
  BU: { printed: 'printed' },
  aggregate: { 'complete-region': 'regionComplete', 'partial-region': 'regionPartial' },
}

/** Documented status and Portuguese label of a stored result status; unknown codes never throw. */
export function resultStatus(code: string, sourceKind: string) {
  const known = Object.hasOwn(codes, sourceKind) ? codes[sourceKind]! : {}
  const key = code.toLowerCase()
  const status = Object.hasOwn(known, key) ? known[key]! : 'unknown'
  return { status, label: labels[status] }
}

function valid(year: string, month: string, day: string, h: string, m: string, s: string) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  return (
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    Number(h) < 24 &&
    Number(m) < 60 &&
    Number(s) < 60
  )
}

/**
 * ISO-8601 form of a source timestamp. TSE JSON files carry `dd/mm/yyyy hh:mm:ss` in Brasília time
 * (UTC−3, without daylight saving since 2019); a bulletin carries `yyyymmddThhmmss` in the voting
 * machine's local time, whose offset the bulletin does not state, so it stays without an offset.
 * Unrecognized text yields null.
 */
export function isoGeneratedAt(original: string | null | undefined) {
  const text = original?.trim() ?? ''
  const json = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(text)
  if (json) {
    const [, day, month, year, h, m, s] = json as unknown as string[]
    return valid(year!, month!, day!, h!, m!, s!)
      ? `${year}-${month}-${day}T${h}:${m}:${s}-03:00`
      : null
  }
  const bulletin = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(text)
  if (bulletin) {
    const [, year, month, day, h, m, s] = bulletin as unknown as string[]
    return valid(year!, month!, day!, h!, m!, s!) ? `${year}-${month}-${day}T${h}:${m}:${s}` : null
  }
  return null
}
