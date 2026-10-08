import { XIcon } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

import type { ElectoralArea } from './api-types'
import {
  candidateTitle,
  CONTRIBUTION_BASIS,
  focusBasisLabel,
  inArea,
  toArea,
} from './candidate-focus'
import { basisLabel, formatInteger, titleCase } from './format'
import type { ClassifiedMap, LegendRow } from './map-classes'
import { METRIC_TITLES, METRIC_UNITS, swatchColor } from './map-format'
import type { MapLayerState } from './use-map-layer'

const SCOPE_NAMES = { pilot: 'Piloto', national: 'Nacional' } as const

function LeaderRow({ row }: { row: LegendRow }) {
  return (
    <li
      className="flex items-center gap-2"
      data-count={row.count}
      title={`${row.title ? `${row.title} · ` : ''}${row.bands
        .map((band) => `${band.label}: ${formatInteger(band.count)}`)
        .join(' · ')}`}
    >
      <span
        aria-hidden="true"
        className="flex h-3 w-10 shrink-0 overflow-hidden rounded-sm bg-muted ring-1 ring-foreground/10"
      >
        {row.bands.map((band) => (
          <span
            key={band.classId}
            className="flex-1"
            style={{ background: swatchColor(row.color, band.alpha) }}
          />
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate">{row.label}</span>
      <span className="text-muted-foreground tabular-nums">{formatInteger(row.count)}</span>
    </li>
  )
}

function BandRow({ row, band }: { row: LegendRow; band: LegendRow['bands'][number] }) {
  return (
    <li className="flex items-center gap-2" data-count={band.count}>
      <span
        aria-hidden="true"
        className="h-3 w-10 shrink-0 rounded-sm ring-1 ring-foreground/10"
        style={{ background: swatchColor(row.color, band.alpha) }}
      />
      <span className="min-w-0 flex-1 truncate tabular-nums">{band.label}</span>
      <span className="text-muted-foreground tabular-nums">{formatInteger(band.count)}</span>
    </li>
  )
}

/**
 * Legend of the data layer: classes with counts in the current scope, grain toggle and
 * coverage. Bottom right, above the source footer, offset by the panel's `--panel-inset`;
 * collapsed into a button below `sm`.
 */
/**
 * Title of a candidate metric: "Apoio a Lula (13 · PT)", "Votos de Lula (13 · PT)",
 * "Contribuição de Lula (13 · PT) para o Acre", and the basis of its percentages.
 */
function focusHeading(classified: ClassifiedMap, areas: readonly FocusArea[]) {
  const { candidate, metric, data } = classified
  if (!candidate || metric === 'leader') return null
  const name = candidateTitle(candidate, titleCase(candidate.displayName))
  const scopeAreaId = 'scopeAreaId' in data ? data.scopeAreaId : null
  const scope =
    scopeAreaId === 'br'
      ? ({ id: 'br', level: 'country', name: 'Brasil' } as const)
      : (areas.find((area) => area.id === scopeAreaId) ?? null)
  // Unavailable items carry `incompatibleOrUnavailableSourceBases`: read an area with data.
  const basis =
    metric === 'contribution'
      ? CONTRIBUTION_BASIS
      : ([...classified.items.values()].find((item) => item.state === 'available')?.basis ?? null)
  const percentages =
    basis && metric !== 'candidateVotes'
      ? `Percentuais ${focusBasisLabel(basis, basisLabel)}`
      : null
  if (metric === 'candidateShare') return { title: `Apoio a ${name}`, percentages }
  if (metric === 'candidateVotes') return { title: `Votos de ${name}`, percentages }
  if (metric === 'contribution')
    return {
      title: `Contribuição de ${name} ${scope ? toArea(scope) : 'para a área do mapa'}`,
      percentages,
      scope: `Cada área sobre os votos de ${titleCase(candidate.displayName)} ${scope ? inArea(scope) : 'na área do mapa'}`,
    }
  return null
}

type FocusArea = Pick<ElectoralArea, 'id' | 'level' | 'name'>

export function MapLegend({
  layer,
  scopeLabel,
  focusAreas = [],
}: {
  layer: MapLayerState
  scopeLabel: string
  /** Selected electoral area and its state, which name the scope of a contribution map. */
  focusAreas?: readonly FocusArea[]
}) {
  const [open, setOpen] = useState(() => matchMedia('(min-width: 40rem)').matches)
  const { legend, classified, status, coverage } = layer
  const metric = classified?.metric
  const focus = classified ? focusHeading(classified, focusAreas) : null
  const title = focus
    ? focus.title
    : metric
      ? `${METRIC_TITLES[metric]}${classified.candidate && metric !== 'leader' ? ` · ${classified.candidate.displayName}` : ''}`
      : 'Mapa'
  const grainLabel = layer.grain === 'state' ? 'Estados' : 'Municípios'
  return (
    <section
      role="region"
      aria-label="Legenda do mapa"
      data-map-legend={status}
      data-map-legend-total={legend?.total}
      data-map-legend-grain={layer.grain}
      className="absolute right-[calc(var(--panel-inset,0px)+1.25rem)] bottom-[calc(var(--panel-inset-bottom,0px)+3.5rem)] flex max-w-[calc(100%-2.5rem)] flex-col items-end sm:right-[calc(var(--panel-inset,0px)+1.75rem)]"
    >
      {open ? (
        <Card size="sm" className="max-h-[55dvh] w-64 overflow-y-auto">
          <CardHeader>
            <CardTitle data-map-legend-title="">{title}</CardTitle>
            <CardDescription>
              {grainLabel} · {scopeLabel}
              {focus?.percentages && (
                <span className="block" data-map-legend-basis="">
                  {focus.percentages}
                </span>
              )}
              {focus && 'scope' in focus && (
                <span className="block" data-map-legend-scope="">
                  {focus.scope}
                </span>
              )}
            </CardDescription>
            <CardAction>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Recolher legenda"
                onClick={() => setOpen(false)}
              >
                <XIcon aria-hidden="true" />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <ToggleGroup
              aria-label="Grão"
              variant="outline"
              size="sm"
              spacing={0}
              value={[layer.grain]}
              onValueChange={(values) => {
                const level = values[0]
                if (level === 'state' || level === 'municipality') layer.setGrain(level)
              }}
            >
              <ToggleGroupItem value="state">Estados</ToggleGroupItem>
              <ToggleGroupItem value="municipality">Municípios</ToggleGroupItem>
            </ToggleGroup>
            {status === 'loading' && (
              <p className="text-muted-foreground" role="status">
                Carregando mapa…
              </p>
            )}
            {status === 'error' && (
              <p role="alert">
                Não foi possível carregar o mapa.{' '}
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={layer.retry}
                >
                  Tentar novamente
                </Button>
              </p>
            )}
            {legend && metric && (
              <>
                <ul className="flex flex-col gap-1" data-map-legend-rows="">
                  {metric === 'leader'
                    ? legend.rows.map((row) => <LeaderRow key={row.id} row={row} />)
                    : legend.rows[0]?.bands.map((band) => (
                        <BandRow key={band.classId} row={legend.rows[0]} band={band} />
                      ))}
                </ul>
                {metric === 'leader' && (
                  <p className="text-muted-foreground">
                    Faixas por {METRIC_UNITS.leader}: {legend.scale.join(' · ')}
                  </p>
                )}
                {metric !== 'leader' && (
                  <p className="text-muted-foreground">Faixas em {METRIC_UNITS[metric]}</p>
                )}
                <p className="flex flex-wrap gap-x-2 text-muted-foreground">
                  <span data-count={legend.tie} title="Liderança dividida entre candidaturas">
                    Empate {formatInteger(legend.tie)}
                  </span>
                  <span
                    data-partial={legend.partial}
                    title="Totalização não concluída; cor atenuada"
                  >
                    Parcial {formatInteger(legend.partial)}
                  </span>
                  <span data-count={legend.missing} title="Sem resultado nesta publicação">
                    Sem dados {formatInteger(legend.missing)}
                  </span>
                </p>
                {coverage && (
                  <p className="text-muted-foreground" data-map-legend-coverage="">
                    {SCOPE_NAMES[coverage.scope]} · {formatInteger(legend.painted)} de{' '}
                    {formatInteger(legend.total)} com dado
                    {coverage.missingResults > 0 &&
                      ` · ${formatInteger(coverage.missingResults)} resultados ausentes`}
                    {coverage.omittedWithoutGeometry > 0 &&
                      ` · ${formatInteger(coverage.omittedWithoutGeometry)} no exterior sem geometria`}
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="bg-background/90"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          Legenda
        </Button>
      )}
    </section>
  )
}
