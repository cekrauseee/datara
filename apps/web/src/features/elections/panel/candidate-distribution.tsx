import { useCallback, useEffect, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

import type { Area } from '../../map/map-data'
import type {
  DistributionLevel as ApiLevel,
  DistributionSort as ApiSort,
  DistributionResponse,
} from '../api-types'
import { areaName, formatFocusPercent } from '../candidate-focus'
import { formatInteger, formatPercent, MISSING } from '../format'
import { useDistribution } from '../use-election-data'
import { PanelError } from './panel-states'

const PAGE_SIZE = 25

type DistributionLevel = NonNullable<ApiLevel>
type DistributionSort = NonNullable<ApiSort>

const SORTS = [
  { value: 'votes', label: 'Votos' },
  { value: 'support', label: 'Apoio' },
  { value: 'contribution', label: 'Contribuição' },
  { value: 'area', label: 'Código' },
] as const satisfies readonly { value: DistributionSort; label: string }[]

const HEADINGS: Record<DistributionLevel, string> = {
  country: 'País',
  region: 'Regiões',
  state: 'Estados',
  municipality: 'Municípios',
  zone: 'Zonas',
  section: 'Seções',
}

type Item = DistributionResponse['items'][number]

/**
 * Distribution of the focused candidate one level below the selected area, from `/distribution`:
 * votes, support and contribution per area with "sem dados", "parcial" and shared-section marks.
 * Sort in local state (default votes), pages accumulated by "Mostrar mais"; states and
 * municipalities select the mesh area, keeping the focus. Mount with a key per candidate and area
 * so sort and pages reset.
 */
export function CandidateDistribution({
  contestId,
  candidateId,
  areaId,
  level,
  placeLabel,
  meshAreas,
  onSelect,
}: {
  contestId: string
  candidateId: string
  areaId: string
  /** "em Porto Walter": the area whose total the contributions add up to. */
  placeLabel: string
  level: DistributionLevel
  /** Mesh areas by IBGE feature ID. */
  meshAreas: ReadonlyMap<string, Area>
  onSelect: (area: Area) => void
}) {
  const [sort, setSort] = useState<DistributionSort>('votes')
  const [pages, setPages] = useState(1)
  const [last, setLast] = useState<{ page: number; hasMore: boolean; total: number } | null>(null)
  const onLoaded = useCallback((page: number, data: DistributionResponse) => {
    setLast((previous) =>
      previous && previous.page > page
        ? previous
        : { page, hasMore: data.pagination.hasMore, total: data.pagination.total },
    )
  }, [])
  const total = last?.total ?? null
  const hasMore = last !== null && last.page === pages - 1 && last.hasMore
  return (
    <section
      className="flex flex-col gap-2"
      aria-label={`Distribuição por ${HEADINGS[level].toLocaleLowerCase('pt-BR')}`}
      data-candidate-distribution={level}
      data-distribution-sort={sort}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-heading font-medium">{HEADINGS[level]}</h3>
        {total !== null && (
          <span className="text-muted-foreground tabular-nums" data-distribution-total={total}>
            {formatInteger(total)}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Ordenar por</span>
        <ToggleGroup
          aria-label="Ordenar por"
          variant="outline"
          size="sm"
          spacing={0}
          value={[sort]}
          onValueChange={(values) => {
            const next = SORTS.find((item) => item.value === values[0])
            if (!next) return
            setSort(next.value)
            setPages(1)
            setLast(null)
          }}
        >
          {SORTS.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value}>
              {item.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <p className="text-muted-foreground">
        Votos · apoio na área · contribuição ao total {placeLabel}
      </p>
      <ol className="flex flex-col">
        {Array.from({ length: pages }, (_, page) => (
          <DistributionPage
            key={`${sort}:${page}`}
            page={page}
            contestId={contestId}
            candidateId={candidateId}
            areaId={areaId}
            level={level}
            sort={sort}
            meshAreas={meshAreas}
            onSelect={onSelect}
            onLoaded={onLoaded}
          />
        ))}
      </ol>
      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setPages((value) => value + 1)}
          data-distribution-more=""
        >
          Mostrar mais
        </Button>
      )}
    </section>
  )
}

function DistributionPage({
  page,
  contestId,
  candidateId,
  areaId,
  level,
  sort,
  meshAreas,
  onSelect,
  onLoaded,
}: {
  page: number
  contestId: string
  candidateId: string
  areaId: string
  level: DistributionLevel
  sort: DistributionSort
  meshAreas: ReadonlyMap<string, Area>
  onSelect: (area: Area) => void
  onLoaded: (page: number, data: DistributionResponse) => void
}) {
  const query = useDistribution(contestId, candidateId, areaId, level, sort, {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  })
  const data = query.data
  useEffect(() => {
    if (data) onLoaded(page, data)
  }, [data, page, onLoaded])
  if (query.status === 'error' && query.error)
    return (
      <li className="py-2">
        <PanelError error={query.error} onRetry={query.retry} />
      </li>
    )
  if (!data)
    return (
      <li className="flex flex-col gap-2 py-2" aria-busy="true">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-4 w-full" />
        ))}
      </li>
    )
  if (data.items.length === 0 && page === 0)
    return <li className="py-2 text-muted-foreground">Nenhuma área abaixo nesta publicação.</li>
  return data.items.map((item) => (
    <DistributionRow
      key={item.area.id}
      item={item}
      mesh={item.area.featureId ? (meshAreas.get(item.area.featureId) ?? null) : null}
      onSelect={onSelect}
    />
  ))
}

function DistributionRow({
  item,
  mesh,
  onSelect,
}: {
  item: Item
  mesh: Area | null
  onSelect: (area: Area) => void
}) {
  const shared = item.state === 'shared'
  const principal = item.area.principalAreaId?.split(':').pop() ?? null
  const content = (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{areaName(item.area)}</span>
        {(item.state === 'unavailable' ||
          shared ||
          (item.state === 'available' && !item.complete)) && (
          <span className="flex flex-wrap gap-1">
            {item.state === 'unavailable' && <Badge variant="outline">sem dados</Badge>}
            {item.state === 'available' && !item.complete && (
              <Badge variant="secondary">parcial</Badge>
            )}
            {shared && (
              <Badge variant="outline">
                {principal ? `contada com a seção ${principal}` : 'contada com a seção principal'}
              </Badge>
            )}
          </span>
        )}
      </span>
      <span className="w-16 shrink-0 text-right tabular-nums" data-distribution-votes="">
        {item.votes === null ? MISSING : formatInteger(item.votes)}
      </span>
      <span
        className="w-12 shrink-0 text-right tabular-nums"
        data-distribution-support=""
        title={item.support.state === 'available' ? undefined : 'Apoio indisponível'}
      >
        {formatPercent(item.support.value)}
      </span>
      <span
        className="w-14 shrink-0 text-right tabular-nums"
        data-distribution-contribution=""
        title={
          item.contribution.state === 'available'
            ? undefined
            : 'Contribuição indisponível: sem resultado ou bases diferentes'
        }
      >
        {formatFocusPercent(item.contribution.value)}
      </span>
    </>
  )
  return (
    <li data-distribution-item={item.area.id}>
      {mesh ? (
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          onClick={() => onSelect(mesh)}
        >
          {content}
        </button>
      ) : (
        <div className="flex items-center gap-2 px-1.5 py-1.5">{content}</div>
      )}
    </li>
  )
}
