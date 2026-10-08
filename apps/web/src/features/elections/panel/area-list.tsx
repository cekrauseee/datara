import { useId, useState } from 'react'

import { Button } from '@/components/ui/button'

import type { Area } from '../../map/map-data'
import type { ContestMapRequest, OfficeMapRequest } from '../election-model'
import { formatInteger, formatPoints } from '../format'
import { useContestMap, useOfficeMap } from '../use-election-data'
import { navigationItems, type NavigationItem } from './panel-model'

const STATUS_TEXT: Record<NavigationItem['status'], string | null> = {
  available: null,
  partial: 'parcial',
  tie: 'empate',
  nodata: 'sem dados',
  unknown: null,
}

/**
 * Navigation to the level below (states of the country, municipalities of a state) and the
 * national view of per-state offices. Items are generic so module 7a can add exterior localities
 * and regions. Leaders come from a map response; without one, only names are listed.
 */
export function AreaList({
  heading,
  description,
  items,
  pageSize = 40,
  loading = false,
  error = null,
  onRetry,
  onSelect,
}: {
  heading: string
  description?: string
  items: readonly NavigationItem[]
  pageSize?: number
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  onSelect: (area: Area) => void
}) {
  const headingId = useId()
  const [shown, setShown] = useState(pageSize)
  if (items.length === 0) return null
  const visible = items.slice(0, shown)
  return (
    <section className="flex flex-col gap-2" aria-labelledby={headingId} data-area-list="">
      <h3 id={headingId} className="text-sm font-medium">
        {heading}
      </h3>
      {description && <p className="text-muted-foreground">{description}</p>}
      {loading && (
        <p className="text-muted-foreground" aria-live="polite">
          Carregando líderes…
        </p>
      )}
      {error && (
        <p className="text-muted-foreground" role="alert">
          Líderes indisponíveis: {error}{' '}
          {onRetry && (
            <Button variant="link" size="sm" className="h-auto p-0" onClick={onRetry}>
              Tentar novamente
            </Button>
          )}
        </p>
      )}
      <ol className="flex flex-col" aria-busy={loading}>
        {visible.map((item) => {
          const status = STATUS_TEXT[item.status]
          return (
            <li key={item.area.id} className="border-t border-border/60 first:border-t-0">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                onClick={() => onSelect(item.area)}
                data-area-item={item.area.id}
              >
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full bg-muted-foreground/30"
                  style={item.leader ? { backgroundColor: item.leader.color } : undefined}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.area.name}</span>
                  {item.status !== 'unknown' && (
                    <span className="block truncate text-muted-foreground">
                      {item.leader
                        ? `${item.leader.name}${item.leader.party ? ` (${item.leader.party})` : ''}`
                        : null}
                      {item.leader && status ? ' · ' : ''}
                      {status}
                    </span>
                  )}
                </span>
                {item.margin !== null && item.status !== 'nodata' && (
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {formatPoints(item.margin)}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ol>
      {items.length > shown && (
        <div>
          <Button variant="outline" size="sm" onClick={() => setShown((value) => value + pageSize)}>
            Mostrar mais ({formatInteger(items.length - shown)})
          </Button>
        </div>
      )}
    </section>
  )
}

type ListProps = {
  heading: string
  description?: string
  areas: readonly Area[]
  pageSize?: number
  onSelect: (area: Area) => void
}

/** Areas of a contest joined with its leader map (president by state, a state by municipality). */
export function ContestAreaList({
  request,
  ...props
}: ListProps & { request: ContestMapRequest | null }) {
  const map = useContestMap(request)
  const items = navigationItems(props.areas, request ? map.data : null)
  return (
    <AreaList
      {...props}
      items={items}
      loading={!!request && map.status === 'loading'}
      error={request && map.error ? map.error.message : null}
      onRetry={map.retry}
    />
  )
}

/** States joined with the cross map by office (national view of governor and senator). */
export function OfficeAreaList({
  request,
  ...props
}: ListProps & { request: OfficeMapRequest | null }) {
  const map = useOfficeMap(request)
  const items = navigationItems(props.areas, request ? map.data : null)
  return (
    <AreaList
      {...props}
      items={items}
      loading={!!request && map.status === 'loading'}
      error={request && map.error ? map.error.message : null}
      onRetry={map.retry}
    />
  )
}
