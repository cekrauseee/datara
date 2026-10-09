import { useCallback, useEffect, useId, useState } from 'react'

import { Button } from '@/components/ui/button'

import type { MapViewData } from '../../map/map-data'
import type { AreaLevel, ElectoralArea } from '../api-types'
import { isCombinationError } from '../depth'
import type { ElectionPatch } from '../election-location'
import { formatInteger, titleCase } from '../format'
import { AREA_PAGE, useAreaPage } from '../use-area-list'
import type { ElectionSnapshot } from '../use-election'
import { errorMessage } from './panel-model'

type ListSpec = {
  parentId: string
  level: AreaLevel
  heading: string
  description: string
  empty: string
  select: (item: ElectoralArea) => ElectionPatch | string | null
}

/**
 * Navigation list of the level below for the areas outside the mesh lists: zones of a
 * municipality or exterior locality, sections of a zone, localities of the exterior, states of a
 * region. Returns `null` at a section (nothing below) and at the mesh levels the panel lists.
 */
export function DepthNavigation({
  election,
  data,
  onPatch,
  onFeature,
}: {
  election: ElectionSnapshot
  data: MapViewData | null
  /** Writes election parameters (zone, section, area). */
  onPatch: (patch: ElectionPatch) => void
  /** Selects a mesh feature by IBGE code (states of a region). */
  onFeature: (featureId: string) => void
}) {
  const spec = listSpec(election, data)
  if (!spec) return null
  return (
    <DepthList
      key={`${spec.parentId}|${spec.level}`}
      spec={spec}
      onSelect={(item) => {
        const target = spec.select(item)
        if (typeof target === 'string') onFeature(target)
        else if (target) onPatch(target)
      }}
    />
  )
}

function listSpec(election: ElectionSnapshot, data: MapViewData | null): ListSpec | null {
  const { state, baseAreaId, areaKind, depth } = election
  if (!baseAreaId || state.section) return null
  if (state.zone) {
    if (!depth.zone) return null
    return {
      parentId: depth.zone.id,
      level: 'section',
      heading: 'Seções',
      description: 'Selecione uma seção para ver o boletim de urna.',
      empty: 'Nenhuma seção publicada nesta zona.',
      select: (item) => (item.sectionCode ? { section: item.sectionCode } : null),
    }
  }
  if (areaKind === 'exterior')
    return {
      parentId: 'exterior',
      level: 'municipality',
      heading: 'Localidades',
      description: 'Cidades com seções no exterior.',
      empty: 'Nenhuma localidade publicada no exterior.',
      select: (item) => ({ area: item.id }),
    }
  if (areaKind === 'region')
    return {
      parentId: baseAreaId,
      level: 'state',
      heading: 'Estados',
      description: 'Estados da região.',
      empty: 'Nenhum estado publicado nesta região.',
      select: (item) =>
        item.featureId && data?.states.some((feature) => feature.properties.id === item.featureId)
          ? item.featureId
          : null,
    }
  if (areaKind === 'locality' || election.electoralArea?.level === 'municipality')
    return {
      parentId: baseAreaId,
      level: 'zone',
      heading: 'Zonas eleitorais',
      description: 'Selecione uma zona para ver suas seções.',
      empty: `Nenhuma zona publicada ${areaKind === 'locality' ? 'nesta localidade' : 'neste município'}.`,
      select: (item) => (item.zoneCode ? { zone: item.zoneCode, section: null } : null),
    }
  return null
}

type Tail = { offset: number; hasMore: boolean; total: number }

function DepthList({
  spec,
  onSelect,
}: {
  spec: ListSpec
  onSelect: (item: ElectoralArea) => void
}) {
  const headingId = useId()
  const [pages, setPages] = useState(1)
  const [tail, setTail] = useState<Tail | null>(null)
  // Section codes by ID across the loaded pages, to name the principal of an aggregated section.
  const [codes, setCodes] = useState<ReadonlyMap<string, string>>(new Map())
  const onLoaded = useCallback((offset: number, items: ElectoralArea[], tail: Tail) => {
    setTail((previous) => (previous && previous.offset > offset ? previous : tail))
    setCodes((previous) => {
      let next: Map<string, string> | null = null
      for (const item of items)
        if (item.sectionCode && !previous.has(item.id)) {
          next ??= new Map(previous)
          next.set(item.id, item.sectionCode)
        }
      return next ?? previous
    })
  }, [])
  const lastOffset = (pages - 1) * AREA_PAGE
  const hasMore = tail !== null && tail.offset === lastOffset && tail.hasMore
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby={headingId}
      data-depth-list={spec.level}
      data-depth-parent={spec.parentId}
    >
      <h3 id={headingId} className="text-sm font-medium">
        {spec.heading}
        {tail && tail.total > 0 && (
          <span className="font-normal text-muted-foreground"> · {formatInteger(tail.total)}</span>
        )}
      </h3>
      {tail?.total !== 0 && <p className="text-muted-foreground">{spec.description}</p>}
      <ol className="flex flex-col">
        {Array.from({ length: pages }, (_, index) => (
          <DepthPage
            key={index}
            spec={spec}
            offset={index * AREA_PAGE}
            codes={codes}
            onLoaded={onLoaded}
            onSelect={onSelect}
          />
        ))}
      </ol>
      {hasMore && (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPages((value) => value + 1)}
            data-load-more=""
          >
            Carregar mais ({formatInteger(tail.total - pages * AREA_PAGE)})
          </Button>
        </div>
      )}
    </section>
  )
}

function DepthPage({
  spec,
  offset,
  codes,
  onLoaded,
  onSelect,
}: {
  spec: ListSpec
  offset: number
  codes: ReadonlyMap<string, string>
  onLoaded: (offset: number, items: ElectoralArea[], tail: Tail) => void
  onSelect: (item: ElectoralArea) => void
}) {
  const query = useAreaPage(spec.parentId, spec.level, offset)
  const data = query.data
  useEffect(() => {
    if (data)
      onLoaded(offset, data.items, {
        offset,
        hasMore: data.pagination.hasMore,
        total: data.pagination.total,
      })
  }, [data, offset, onLoaded])
  if (query.status === 'error' && query.error) {
    const combination = isCombinationError(query.error)
    return (
      <li className="py-2 text-muted-foreground" role="alert" data-depth-error={query.error.code}>
        {combination ? 'Combinação não disponível: ' : 'Lista indisponível: '}
        {errorMessage(query.error)}{' '}
        {!combination && (
          <Button variant="link" size="sm" className="h-auto p-0" onClick={query.retry}>
            Tentar novamente
          </Button>
        )}
      </li>
    )
  }
  if (!data)
    return (
      <li className="py-2 text-muted-foreground" aria-live="polite">
        Carregando {spec.heading.toLocaleLowerCase('pt-BR')}…
      </li>
    )
  if (data.pagination.total === 0)
    return (
      <li className="py-2 text-muted-foreground" data-depth-empty="">
        {spec.empty}
      </li>
    )
  return data.items.map((item) => {
    const principal = item.principalAreaId ? codes.get(item.principalAreaId) : null
    const selectable = spec.select(item) !== null
    return (
      <li key={item.id} className="border-t border-border/60 first:border-t-0">
        <button
          type="button"
          disabled={!selectable}
          className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
          onClick={() => onSelect(item)}
          data-depth-item={item.id}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate">{titleCase(item.name)}</span>
            {item.principalAreaId && (
              <span className="block truncate text-muted-foreground" data-aggregated="">
                agregada → {principal ? `Seção ${principal}` : 'seção principal'}
              </span>
            )}
          </span>
        </button>
      </li>
    )
  })
}
