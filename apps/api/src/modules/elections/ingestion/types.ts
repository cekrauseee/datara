import type { NetworkOptions } from './fetch.js'

export type Office = { cd: string; ds: string; tp: string }
export type Configuration = {
  f: string
  pl: {
    cd: string
    c: string
    dt: string
    e: { cd: string; t: string; abr: { cd: string; cp: Office[] }[] }[]
  }[]
}
export type Municipality = { cd: string; cdi?: string; nm: string; z: string[] }
export type Municipalities = { f: string; abr: { cd: string; ds: string; mu: Municipality[] }[] }
export type Sections = {
  f: string
  abr: {
    cd: string
    mu: {
      cd: string
      zon: {
        cd: string
        // da/ha: when the section auxiliary file (EA18) was produced; absent when none exists.
        sec: { ns: string; nsp?: string; nsa?: string[]; da?: string; ha?: string }[]
      }[]
    }[]
  }[]
}
export type Auxiliary = {
  f: string
  st: string
  hashes?: { hash: string; st: string; arq?: { nm: string; tp: string }[] }[]
}
export type Candidate = {
  sqcand: string
  n: string
  nm: string
  nmu: string
  st?: string
  dvt?: string
  e?: string
  vap?: string
  pvapn?: string
  vs?: unknown[]
}
export type Party = {
  n: string
  sg: string
  nm: string
  nfed?: string
  tvtn?: string
  tvan?: string
  tvtl?: string
  tval?: string
  cand: Candidate[]
}
export type UnifiedResult = {
  f: string
  ele: string
  t: string
  tpabr: string
  cdabr: string
  tf: string
  and: string
  dg: string
  hg: string
  carg: {
    cd: string
    nmn: string
    nv: string
    fed?: { n: string }[]
    agr: { n: string; nm: string; tp: string; com: string; par: Party[] }[]
  }[]
  s: Record<string, string>
  e: Record<string, string>
  v: Record<string, string>
}
export type ImportOptions = {
  publicationId?: string
  scope: 'pilot' | 'national'
  archiveDir: string
  offline?: boolean
  refresh?: boolean
  // Pilot imports all offices but limits municipalities and primary BUs per UF; national has no limit.
  municipalitiesPerUf?: number
  sectionsPerUf?: number
  pilotUfs?: string[]
  publish?: boolean
  // Operational parameters below never change the dataset and are not persisted for resume.
  stopAfter?: number
  /** Record unit failures and continue; the run then ends paused. Default: national scope. */
  keepGoing?: boolean
  /** Build the inventory, report the expected volume and pause without downloading results. */
  estimate?: boolean
  progressIntervalMs?: number
  network?: NetworkOptions
  /** Aborting pauses the run after the current unit. */
  signal?: AbortSignal
}
export const EDITION = 'BR-2026-1'
export const PARSER_VERSION = 'tse2026-2'
export const regionStates: Record<string, string[]> = {
  north: ['ac', 'am', 'ap', 'pa', 'ro', 'rr', 'to'],
  northeast: ['al', 'ba', 'ce', 'ma', 'pb', 'pe', 'pi', 'rn', 'se'],
  southeast: ['es', 'mg', 'rj', 'sp'],
  south: ['pr', 'rs', 'sc'],
  centralwest: ['df', 'go', 'ms', 'mt'],
}
export const regionNames: Record<string, string> = {
  north: 'Norte',
  northeast: 'Nordeste',
  southeast: 'Sudeste',
  south: 'Sul',
  centralwest: 'Centro-Oeste',
}
export function contestId(election: string, office: string, scope: string) {
  return `${EDITION}:${election}:${office}:${scope}`
}
/** Area ID of a contest's official scope: the document for that area carries its catalog. */
export function contestScope(id: string) {
  return id.replace(/^[^:]+:[^:]+:[^:]+:/, '')
}
export function count(value: string | undefined): number | null {
  if (value === undefined) return null
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`Invalid source count: ${value}`)
  return Number(value)
}
