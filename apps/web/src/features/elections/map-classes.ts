// Pure classification of a map response into layer fills, colour classes and legend counts.
// Only type imports: `scripts/check-map-layer.mjs` runs this file in Node without a bundler.
//
// Fixed breaks (documented here, not quantiles):
// - leader: colour of the leader, alpha by margin band <5, 5–15, 15–30, ≥30 p.p.;
// - margin: the same bands on the neutral `--foreground` ramp, which inverts with the theme;
// - turnout: <60, 60–70, 70–75, 75–80, ≥80 % on the `--foreground` ramp;
// - candidateShare: <10, 10–25, 25–40, 40–55, ≥55 % of the candidate colour;
// - contribution: <0.1, 0.1–0.5, 0.5–2, 2–10, ≥10 % of the candidate colour;
// - candidateVotes: <1 thousand, 1–10, 10–100 thousand, 100 thousand–1 million, ≥1 million.
// Alphas compose over `--muted` in both themes (checked by `check-map-layer-browser.mjs`).
import type { LayerClass, LayerColor, LayerFill, LayerGrain, MapLayer } from '../map/map-layer'
import type { ElectionMapResponse, MapMetric, MapResponse } from './api-types'

export type MapData = MapResponse | ElectionMapResponse
export type MapDataItem = MapData['items'][number]
export type MapDataCandidate = MapData['candidates'][string]

export type FillMeta = MapDataItem

export type Band = { index: number; label: string; alpha: number }

export type LegendGroup = {
  id: string
  /** "Name (PARTY)" in one contest; "PARTY" in cross maps. */
  label: string
  color: LayerColor
  /** Candidates grouped under this colour, for the title. */
  candidates: string[]
  /** One class per band, in band order. */
  classIds: string[]
}

export type ClassifiedMap = {
  data: MapData
  metric: MapMetric
  grain: LayerGrain
  cross: boolean
  candidate: MapDataCandidate | null
  layer: MapLayer<FillMeta>
  items: Map<string, MapDataItem>
  /** Leaders (leader metric) or a single neutral group (other metrics). */
  groups: LegendGroup[]
  bands: Band[]
  unit: 'pp' | 'percent' | 'votes'
}

export type LegendRow = {
  id: string
  label: string
  color: LayerColor
  title: string
  count: number
  bands: { classId: string; alpha: number; label: string; count: number }[]
}

export type LegendModel = {
  rows: LegendRow[]
  tie: number
  partial: number
  missing: number
  /** Items in scope. */
  total: number
  /** Items in scope with a fill. */
  painted: number
  /** Break labels, in band order. */
  scale: string[]
  unit: 'pp' | 'percent' | 'votes'
}

const MARGIN_BREAKS = [5, 15, 30]
const MARGIN_LABELS = ['<5', '5–15', '15–30', '≥30']
const LEADER_ALPHAS = [0.35, 0.55, 0.78, 1]
const NEUTRAL_MARGIN_ALPHAS = [0.2, 0.45, 0.7, 0.9]
const TURNOUT_BREAKS = [60, 70, 75, 80]
const TURNOUT_LABELS = ['<60', '60–70', '70–75', '75–80', '≥80']
const TURNOUT_ALPHAS = [0.12, 0.28, 0.45, 0.62, 0.8]
const SHARE_BREAKS = [10, 25, 40, 55]
const SHARE_LABELS = ['<10', '10–25', '25–40', '40–55', '≥55']
const CONTRIBUTION_BREAKS = [0.1, 0.5, 2, 10]
const CONTRIBUTION_LABELS = ['<0,1', '0,1–0,5', '0,5–2', '2–10', '≥10']
const VOTES_BREAKS = [1e3, 1e4, 1e5, 1e6]
const VOTES_LABELS = ['<1 mil', '1–10 mil', '10–100 mil', '100 mil–1 mi', '≥1 mi']
const CANDIDATE_ALPHAS = [0.2, 0.4, 0.6, 0.8, 1]

export const TIE_CLASS_ID = 'tie'
const FOREGROUND: LayerColor = { token: 'foreground' }

function bands(labels: string[], alphas: number[]): Band[] {
  return labels.map((label, index) => ({ index, label, alpha: alphas[index] }))
}

function bandIndex(value: number, breaks: number[]) {
  const index = breaks.findIndex((limit) => value < limit)
  return index === -1 ? breaks.length : index
}

const METRIC_BANDS: Record<
  MapMetric,
  { breaks: number[]; bands: Band[]; unit: LegendModel['unit'] }
> = {
  leader: { breaks: MARGIN_BREAKS, bands: bands(MARGIN_LABELS, LEADER_ALPHAS), unit: 'pp' },
  margin: { breaks: MARGIN_BREAKS, bands: bands(MARGIN_LABELS, NEUTRAL_MARGIN_ALPHAS), unit: 'pp' },
  turnout: {
    breaks: TURNOUT_BREAKS,
    bands: bands(TURNOUT_LABELS, TURNOUT_ALPHAS),
    unit: 'percent',
  },
  candidateShare: {
    breaks: SHARE_BREAKS,
    bands: bands(SHARE_LABELS, CANDIDATE_ALPHAS),
    unit: 'percent',
  },
  contribution: {
    breaks: CONTRIBUTION_BREAKS,
    bands: bands(CONTRIBUTION_LABELS, CANDIDATE_ALPHAS),
    unit: 'percent',
  },
  candidateVotes: {
    breaks: VOTES_BREAKS,
    bands: bands(VOTES_LABELS, CANDIDATE_ALPHAS),
    unit: 'votes',
  },
}

export function metricBands(metric: MapMetric) {
  return METRIC_BANDS[metric]
}

export function isCrossMap(data: MapData): data is ElectionMapResponse {
  return 'officeCode' in data
}

function colorKey(candidate: MapDataCandidate) {
  return `${candidate.color.toLowerCase()}|${candidate.party?.abbreviation ?? ''}`
}

function partyLabel(candidate: MapDataCandidate) {
  return candidate.party?.abbreviation ?? candidate.displayName
}

export function candidateLabel(candidate: MapDataCandidate, cross: boolean) {
  if (cross) return partyLabel(candidate)
  return candidate.party
    ? `${candidate.displayName} (${candidate.party.abbreviation})`
    : candidate.displayName
}

/** The fill of an item, or `null` when it stays on the base (counted as "Sem dados"). */
function classify(
  item: MapDataItem,
  metric: MapMetric,
  breaks: number[],
): { classId: string; band: number | null; leaderKey: string | null } | null {
  if (item.state !== 'available') return null
  if (metric === 'leader' || metric === 'margin') {
    if (item.tie) return { classId: TIE_CLASS_ID, band: null, leaderKey: null }
    if (item.leaders.length === 0) return null
    if (metric === 'margin' && item.value === null) return null
    // A hidden margin (unresolved votables, single candidacy) takes the lowest band.
    const band = item.margin === null ? 0 : bandIndex(item.margin, breaks)
    return metric === 'leader'
      ? { classId: '', band, leaderKey: item.leaders[0] }
      : { classId: `margin:${band}`, band, leaderKey: null }
  }
  if (item.value === null) return null
  const band = bandIndex(item.value, breaks)
  return { classId: `${metric}:${band}`, band, leaderKey: null }
}

/** Fills, classes and legend groups of one response; the layer covers the whole payload. */
export function classifyMap(data: MapData): ClassifiedMap {
  const cross = isCrossMap(data)
  const metric = data.metric
  const { breaks, bands, unit } = METRIC_BANDS[metric]
  const candidateId = isCrossMap(data) ? null : data.candidateId
  const candidate = (candidateId && data.candidates[candidateId]) || null
  const classes = new Map<string, LayerClass>()
  const fills = new Map<string, LayerFill<FillMeta>>()
  const items = new Map<string, MapDataItem>()
  const groups = new Map<string, LegendGroup>()
  const sequentialColor: LayerColor =
    metric === 'margin' || metric === 'turnout' ? FOREGROUND : (candidate?.color ?? FOREGROUND)

  if (metric !== 'leader') {
    const group: LegendGroup = {
      id: metric,
      label: metric,
      color: sequentialColor,
      candidates: candidate ? [candidate.displayName] : [],
      classIds: bands.map((band) => `${metric}:${band.index}`),
    }
    groups.set(group.id, group)
    for (const band of bands)
      classes.set(`${metric}:${band.index}`, {
        id: `${metric}:${band.index}`,
        color: sequentialColor,
        alpha: band.alpha,
        label: band.label,
        order: band.index,
      })
  }

  for (const item of data.items) {
    items.set(item.featureId, item)
    const result = classify(item, metric, breaks)
    if (!result) continue
    let classId = result.classId
    if (result.leaderKey !== null) {
      const leader = data.candidates[result.leaderKey]
      if (!leader) continue
      const key = colorKey(leader)
      let group = groups.get(key)
      if (!group) {
        group = {
          id: key,
          label: candidateLabel(leader, cross),
          color: leader.color,
          candidates: [],
          classIds: bands.map((band) => `leader:${key}:${band.index}`),
        }
        groups.set(key, group)
        for (const band of bands)
          classes.set(`leader:${key}:${band.index}`, {
            id: `leader:${key}:${band.index}`,
            color: leader.color,
            alpha: band.alpha,
            label: `${group.label} ${band.label}`,
            order: band.index,
          })
      }
      if (!group.candidates.includes(leader.displayName)) group.candidates.push(leader.displayName)
      classId = `leader:${key}:${result.band}`
    }
    fills.set(item.featureId, {
      featureId: item.featureId,
      classId,
      partial: !item.complete,
      meta: item,
    })
  }
  if (cross) disambiguate(groups)
  if ([...fills.values()].some((fill) => fill.classId === TIE_CLASS_ID))
    classes.set(TIE_CLASS_ID, {
      id: TIE_CLASS_ID,
      color: { token: 'muted-foreground' },
      alpha: 0.6,
      label: 'Empate',
      order: bands.length,
    })

  const source = cross ? `office:${data.officeCode}` : `contest:${data.contestId}`
  return {
    data,
    metric,
    grain: data.level,
    cross,
    candidate,
    layer: {
      key: `${data.publicationId}|${source}|${data.level}|${metric}|${candidateId ?? ''}`,
      grain: data.level,
      classes,
      fills,
    },
    items,
    groups: [...groups.values()],
    bands,
    unit,
  }
}

// Two colours of the same party (a second senate seat, for instance) keep distinct labels.
function disambiguate(groups: Map<string, LegendGroup>) {
  const byLabel = new Map<string, LegendGroup[]>()
  for (const group of groups.values()) {
    const list = byLabel.get(group.label)
    if (list) list.push(group)
    else byLabel.set(group.label, [group])
  }
  for (const list of byLabel.values())
    if (list.length > 1)
      for (const group of list) group.label = `${group.label} (${group.candidates.join(', ')})`
}

/** The IBGE scope prefix an item must match: a two-digit state code filters municipal maps. */
function inScope(featureId: string, scope: string | null) {
  return scope === null || featureId.startsWith(scope)
}

/**
 * Legend counts within `scope` (two-digit state code, municipal grain only). Partial fills are
 * also counted in their class; rows + tie + missing = total.
 */
export function legendCounts(classified: ClassifiedMap, scope: string | null): LegendModel {
  const prefix = classified.grain === 'municipality' ? scope : null
  const counts = new Map<string, number>()
  let tie = 0
  let partial = 0
  let missing = 0
  let total = 0
  for (const item of classified.items.values()) {
    if (!inScope(item.featureId, prefix)) continue
    total++
    const fill = classified.layer.fills.get(item.featureId)
    if (!fill) {
      missing++
      continue
    }
    if (fill.partial) partial++
    if (fill.classId === TIE_CLASS_ID) tie++
    else counts.set(fill.classId, (counts.get(fill.classId) ?? 0) + 1)
  }
  const rows: LegendRow[] = []
  for (const group of classified.groups) {
    const bands = group.classIds.map((classId, index) => ({
      classId,
      alpha: classified.bands[index].alpha,
      label: classified.bands[index].label,
      count: counts.get(classId) ?? 0,
    }))
    const count = bands.reduce((sum, band) => sum + band.count, 0)
    if (classified.metric === 'leader' && count === 0) continue
    rows.push({
      id: group.id,
      label: group.label,
      color: group.color,
      title: group.candidates.join(', '),
      count,
      bands,
    })
  }
  if (classified.metric === 'leader') rows.sort((a, b) => b.count - a.count)
  return {
    rows,
    tie,
    partial,
    missing,
    total,
    painted: total - missing,
    scale: classified.bands.map((band) => band.label),
    unit: classified.unit,
  }
}
