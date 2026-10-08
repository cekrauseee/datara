import { useMemo } from 'react'

import type { MapLayer } from '../map/map-layer'
import type { ApiClientError } from './api-client'
import type { Coverage } from './api-types'
import type { Level } from './election-location'
import type { MapRequest } from './election-model'
import {
  classifyMap,
  legendCounts,
  type ClassifiedMap,
  type FillMeta,
  type LegendModel,
} from './map-classes'
import type { ElectionSnapshot } from './use-election'
import { useElectionMap } from './use-election-data'
import { navigateElection } from './use-election-location'

export type MapLayerState = {
  /** The current office has a map slot: the layer and the legend apply. */
  active: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: ApiClientError | null
  retry: () => void
  /** Layer for `MapControls.setLayer`; the previous one stays while a new request loads. */
  layer: MapLayer<FillMeta> | null
  classified: ClassifiedMap | null
  /** State-level values for the tooltip at national zoom: the companion map, or the map itself. */
  stateLevel: ClassifiedMap | null
  /** Counts within the selected state (municipal grain) or the whole payload. */
  legend: LegendModel | null
  coverage: {
    scope: Coverage['scope']
    missingResults: number
    omittedWithoutGeometry: number
  } | null
  grain: Level
  setGrain: (level: Level) => void
}

/**
 * Map slot of the current selection classified into a layer, with the state-level companion
 * requested alongside the municipal payload (6 KB) for the tooltip at national zoom.
 */
export function useMapLayer(election: ElectionSnapshot, scope: string | null): MapLayerState {
  const request = election.mapRequest
  const query = useElectionMap(request)
  const companionRequest: MapRequest | null =
    request && request.level === 'municipality' ? { ...request, level: 'state' } : null
  const companion = useElectionMap(companionRequest)

  const data = request ? (query.data ?? query.previous) : null
  const classified = useMemo(() => (data ? classifyMap(data) : null), [data])
  const companionData = companionRequest ? (companion.data ?? companion.previous) : null
  const companionClassified = useMemo(
    () => (companionData ? classifyMap(companionData) : null),
    [companionData],
  )
  const legend = useMemo(
    () => (classified ? legendCounts(classified, scope) : null),
    [classified, scope],
  )

  return {
    active: request !== null,
    status: query.status,
    error: query.error,
    retry: () => {
      if (query.status === 'error') query.retry()
      if (companion.status === 'error') companion.retry()
    },
    layer: classified?.layer ?? null,
    classified,
    stateLevel: classified?.grain === 'state' ? classified : companionClassified,
    legend,
    coverage: data
      ? {
          scope: data.coverage.scope,
          missingResults: data.missingResults,
          omittedWithoutGeometry: data.omittedWithoutGeometry,
        }
      : null,
    grain: election.state.level,
    setGrain: (level) => navigateElection({ level }),
  }
}
