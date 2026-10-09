import { Badge } from '@/components/ui/badge'

import type { Area } from '../map/map-data'
import { formatPercent, formatPoints, formatVotes } from './format'
import type { ClassifiedMap, MapDataItem } from './map-classes'
import { swatchColor } from './map-format'
import type { MapLayerState } from './use-map-layer'

export type HoverTarget = { classified: ClassifiedMap; featureId: string; prefix?: string }

/**
 * The painted unit that contains the hovered area: a state answers with the state-level map; a
 * municipality answers with its own fill at municipal grain, or with its state's fill, named,
 * at state grain.
 */
export function hoverTarget(
  layer: MapLayerState,
  area: Area,
  stateName: string | undefined,
): HoverTarget | null {
  if (area.type === 'state')
    return layer.stateLevel ? { classified: layer.stateLevel, featureId: area.id } : null
  if (area.type !== 'municipality' || !layer.classified) return null
  if (layer.classified.grain === 'municipality')
    return { classified: layer.classified, featureId: area.id }
  return layer.stateLevel
    ? {
        classified: layer.stateLevel,
        featureId: area.stateCode,
        prefix: `UF: ${stateName ?? area.stateAbbr}`,
      }
    : null
}

function leaderOf(classified: ClassifiedMap, item: MapDataItem) {
  const id = item.leaders[0]
  return id ? (classified.data.candidates[id] ?? null) : null
}

function metricLine(classified: ClassifiedMap, item: MapDataItem) {
  const value = item.value
  switch (classified.metric) {
    case 'leader':
      return value === null ? null : formatVotes(value)
    case 'margin':
      return value === null ? 'Vantagem —' : `Vantagem ${formatPoints(value)}`
    case 'turnout':
      return value === null ? 'Comparecimento —' : `Comparecimento ${formatPercent(value)}`
    case 'candidateShare':
      return value === null ? 'Apoio —' : `Apoio ${formatPercent(value, { fine: true })}`
    case 'contribution':
      return value === null
        ? 'Contribuição —'
        : `Contribuição ${formatPercent(value, { fine: true })}`
    case 'candidateVotes':
      return value === null ? 'Votos —' : formatVotes(value)
  }
}

export function MapHoverDetail({ target }: { target: HoverTarget }) {
  const { classified, featureId, prefix } = target
  const item = classified.items.get(featureId)
  const fill = classified.layer.fills.get(featureId)
  const cls = fill ? classified.layer.classes.get(fill.classId) : undefined
  const leader = item ? leaderOf(classified, item) : null
  const available = item?.state === 'available'
  const ties = item?.tie
    ? item.leaders.map((id) => classified.data.candidates[id]?.displayName ?? id)
    : []
  return (
    <div className="flex flex-col gap-1" data-map-hover-detail={featureId}>
      {prefix && <p className="text-muted-foreground">{prefix}</p>}
      {!item || !available ? (
        <p data-map-hover-missing="">Sem dados nesta publicação</p>
      ) : (
        <>
          {leader && (
            <p className="flex items-center gap-2" data-map-hover-leader="">
              <span
                aria-hidden="true"
                className="size-3 shrink-0 rounded-sm ring-1 ring-foreground/20"
                style={{
                  background: cls
                    ? swatchColor(cls.color, cls.alpha * (fill?.partial ? 0.6 : 1))
                    : leader.color,
                }}
              />
              <span className="min-w-0 truncate font-medium">
                {leader.displayName}
                {leader.party && ` · ${leader.party.abbreviation}`}
              </span>
            </p>
          )}
          {classified.metric === 'leader' && item.margin !== null && !item.tie && (
            <p>Vantagem {formatPoints(item.margin)}</p>
          )}
          {metricLine(classified, item) && (
            <p className="tabular-nums" data-map-hover-value="">
              {metricLine(classified, item)}
            </p>
          )}
          {classified.candidate && classified.metric !== 'leader' && (
            <p className="text-muted-foreground">{classified.candidate.displayName}</p>
          )}
          {(item.tie || !item.complete) && (
            <p className="flex flex-wrap gap-1">
              {item.tie && (
                <Badge variant="outline" data-map-hover-tie="">
                  Empate: {ties.join(', ')}
                </Badge>
              )}
              {!item.complete && (
                <Badge variant="outline" data-map-hover-partial="">
                  Parcial
                </Badge>
              )}
            </p>
          )}
        </>
      )}
    </div>
  )
}
