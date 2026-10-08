import { cn } from 'cn'
import { MapPinIcon, MinusIcon, PlusIcon, ScanIcon } from 'lucide-react'
import { useDeferredValue, useEffect, useEffectEvent, useRef, useState } from 'react'

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox'

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

import {
  CollectionSelector,
  hoverTarget,
  MapHoverDetail,
  MapLegend,
  ResultsPanel,
  useElection,
  useMapLayer,
  useMediaQuery,
} from '../elections'
import { loadDetailFeature } from './map-cache'
import { createMap, type MapControls, type MapHover } from './map-canvas'
import { countries, type CountryCode } from './map-countries'
import { areaLabel, searchAreas, type Area, type MapViewData } from './map-data'
import { MAX_ZOOM } from './map-geometry'
import { MapSkeleton } from './map-skeleton'
import { MapTooltip } from './map-tooltip'
import { useMapData } from './use-map-data'
import { navigateCountry, navigateMap, useMapLocation } from './use-map-location'

export function MapExplorer() {
  const { countryCode, selectionId } = useMapLocation()
  const [hasSwitched, setHasSwitched] = useState(false)
  const [locations, setLocations] = useState<Partial<Record<CountryCode, string | null>>>(() => ({
    [countryCode]: selectionId,
  }))
  useEffect(() => {
    setLocations((previous) =>
      countryCode in previous && previous[countryCode] === selectionId
        ? previous
        : { ...previous, [countryCode]: selectionId },
    )
  }, [countryCode, selectionId])

  return (Object.keys(countries) as CountryCode[]).map((code) => {
    const active = code === countryCode
    if (!active && !(code in locations)) return null
    return (
      <div key={code} data-map-country={code} hidden={!active}>
        <CountryMap
          active={active}
          countryCode={code}
          selectionId={active ? selectionId : (locations[code] ?? null)}
          onSelect={(area, replace) => {
            if (active) navigateMap(code, area, replace)
          }}
          focusCountrySwitcher={hasSwitched}
          onCountryChange={(next) => {
            setHasSwitched(true)
            navigateCountry(next)
          }}
        />
      </div>
    )
  })
}

function CountryMap({
  active,
  countryCode,
  selectionId,
  onSelect,
  onCountryChange,
  focusCountrySwitcher,
}: {
  active: boolean
  countryCode: CountryCode
  selectionId: string | null
  onSelect: (area: Area | null, replace?: boolean) => void
  focusCountrySwitcher: boolean
  onCountryChange: (code: CountryCode) => void
}) {
  const country = countries[countryCode]
  const {
    data,
    error: loadError,
    localAreas,
    searchStatus,
    detailError,
    loadingDetails,
    loadDetails,
    retryDetails,
    retry,
  } = useMapData(countryCode)
  const selectionRequest = useRef(0)
  const appliedSelection = useRef<{ data: MapViewData; id: string | null } | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const countryButton = useRef<HTMLButtonElement>(null)
  const controls = useRef<MapControls | null>(null)
  const [ready, setReady] = useState(false)
  const [renderError, setRenderError] = useState('')
  const error = loadError || renderError
  const [selected, setSelected] = useState<Area | null>(null)
  const [hover, setHover] = useState<MapHover>(null)
  const [scale, setScale] = useState(1)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const election = useElection({ countryCode, selectionId })
  const mapLayer = useMapLayer(election, selected?.stateCode ?? null)
  const desktop = useMediaQuery('(min-width: 40rem)')
  // Notice of the office selector when the new area does not contest the office.
  const [officeNotice, setOfficeNotice] = useState<string | null>(null)
  useEffect(() => {
    if (election.office || !election.active) setOfficeNotice(null)
  }, [election.office, election.active])

  const deferredQuery = useDeferredValue(query)

  useEffect(() => {
    if (!active) {
      setSearchOpen(false)
      setHover(null)
    } else if (focusCountrySwitcher) countryButton.current?.focus()
  }, [active, focusCountrySwitcher])

  async function ensureDetails(stateCode: string) {
    await loadDetails(stateCode)
    await controls.current?.addDetails(stateCode)
  }

  async function applySelection(area: Area | null) {
    const request = ++selectionRequest.current
    setSelected(area)
    setQuery('')
    if (area?.type === 'place' || area?.type === 'subdivision') {
      try {
        await loadDetails(area.stateCode)
        const feature = await loadDetailFeature(area.stateCode, area.id)
        if (request !== selectionRequest.current) return
        controls.current?.fit(area.id, feature)
        void controls.current?.addDetails(area.stateCode).catch(() => {})
      } catch {
        /* The data hook exposes a retry action. */
      }
      return
    }
    if (request === selectionRequest.current) controls.current?.fit(area?.id ?? null)
  }

  function choose(area: Area | null) {
    if ((area?.id ?? null) === selectionId) void applySelection(area)
    else onSelect(area)
  }

  const requestDetails = useEffectEvent((states: string[]) => {
    for (const state of states) void ensureDetails(state).catch(() => {})
  })
  const selectArea = useEffectEvent(choose)
  useEffect(() => {
    setReady(false)
    setRenderError('')
    if (!data || !canvas.current) return
    try {
      controls.current = createMap(canvas.current, data, {
        onDetails: requestDetails,
        onError: () => setRenderError('Não foi possível desenhar o mapa neste navegador.'),
        onReady: () => setReady(true),
        onSelect: selectArea,
        onHover: setHover,
        onZoom: setScale,
      })
    } catch {
      setRenderError('Não foi possível desenhar o mapa neste navegador.')
    }
    return () => {
      controls.current?.destroy()
      controls.current = null
    }
  }, [data])
  useEffect(() => {
    controls.current?.setLayer(mapLayer.layer)
  }, [mapLayer.layer, data])

  const areas = data
    ? [...data.states, ...data.regions].map((feature) => feature.properties).concat(localAreas)
    : []
  const matches = deferredQuery.trim()
    ? searchAreas(areas, deferredQuery)
    : (data?.states.map((feature) => feature.properties) ?? [])
  const state = selected
    ? data?.states.find((feature) => feature.properties.stateCode === selected.stateCode)
        ?.properties
    : null

  const restoreSelection = useEffectEvent(applySelection)
  const canonicalSelection = useEffectEvent((area: Area) => onSelect(area, true))
  const locationArea = areas.find((area) => area.id === selectionId)
  const locationMissing = !!selectionId && !locationArea && searchStatus === 'ready'

  useEffect(() => {
    if (
      !data ||
      (appliedSelection.current?.data === data && appliedSelection.current.id === selectionId)
    )
      return
    selectionRequest.current++
    if (selectionId && !locationArea && searchStatus !== 'ready') return
    appliedSelection.current = { data, id: selectionId }
    void restoreSelection(locationArea ?? null)
    if (locationArea) canonicalSelection(locationArea)
  }, [data, selectionId, locationArea, searchStatus])

  return (
    <div className="flex h-dvh min-h-[28rem] flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b px-5 py-4 sm:px-7">
        <h1 className="sr-only">datara</h1>
        <div className="flex flex-wrap items-center gap-4">
          <ToggleGroup
            aria-label="País"
            variant="outline"
            spacing={0}
            value={[countryCode]}
            onValueChange={(values) => {
              const code = values[0]
              if (code === 'BR' || code === 'US') onCountryChange(code)
            }}
          >
            <ToggleGroupItem
              ref={countryCode === 'BR' ? countryButton : undefined}
              value="BR"
              className="h-10 px-4"
            >
              Brasil
            </ToggleGroupItem>
            <ToggleGroupItem
              ref={countryCode === 'US' ? countryButton : undefined}
              value="US"
              className="h-10 px-4"
            >
              Estados Unidos
            </ToggleGroupItem>
          </ToggleGroup>
          {countryCode === 'BR' && (
            <CollectionSelector
              election={election}
              areaName={selected?.name ?? country.name}
              onOfficeCleared={setOfficeNotice}
            />
          )}
        </div>
        <div className="w-full sm:w-80">
          <label htmlFor={`map-search-${countryCode}`} className="sr-only">
            {country.searchPlaceholder}
          </label>
          <Combobox<Area>
            open={active && searchOpen}
            onOpenChange={setSearchOpen}
            items={matches}
            filter={null}
            value={selected}
            inputValue={query}
            onInputValueChange={setQuery}
            onValueChange={choose}
            itemToStringLabel={(area) => `${area.name} · ${area.stateAbbr}`}
            itemToStringValue={(area) => area.id}
            isItemEqualToValue={(a, b) => a.id === b.id}
            autoHighlight
          >
            <ComboboxInput
              id={`map-search-${countryCode}`}
              placeholder={country.searchPlaceholder}
              disabled={!ready}
              showClear
              className="h-10 w-full"
            />
            <ComboboxContent>
              <ComboboxEmpty>
                {searchStatus === 'loading'
                  ? 'Carregando localidades…'
                  : 'Nenhum lugar encontrado. Tente outro nome ou código.'}
              </ComboboxEmpty>
              {searchStatus === 'error' && (
                <div className="px-3 py-2" role="alert">
                  Não foi possível carregar todas as localidades.
                  <Button variant="link" onClick={retry}>
                    Tentar novamente
                  </Button>
                </div>
              )}
              <ComboboxList>
                {(area: Area) => (
                  <ComboboxItem key={area.id} value={area} className="min-h-10">
                    <MapPinIcon aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{area.name}</span>
                    <span className="mr-4 text-muted-foreground">
                      {areaLabel(area)} · {area.stateAbbr}
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        </div>
      </header>

      <main
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden [--panel-inset-bottom:0px] [--panel-inset:0px]',
          // `--panel-inset`: width of the results column (plus its gap) at `sm+`, consumed by the
          // legend and the overlays on the right; `--panel-inset-bottom`: height of the collapsed
          // mobile sheet, consumed by the controls, the footer and the status chip.
          election.active && election.office
            ? 'max-sm:[--panel-inset-bottom:3.5rem] sm:[--panel-inset:20.75rem] lg:[--panel-inset:22.75rem]'
            : selected && 'sm:[--panel-inset:15.75rem]',
        )}
        aria-label={`Explorar ${country.name}`}
      >
        <canvas
          ref={canvas}
          className="absolute inset-0 size-full cursor-grab touch-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          role="img"
          tabIndex={ready ? 0 : -1}
          aria-hidden={!ready}
          aria-label={`Mapa interativo — ${country.name}`}
          aria-describedby={`map-instructions-${countryCode}`}
          onKeyDown={(event) => {
            const pans: Record<string, [number, number]> = {
              ArrowLeft: [80, 0],
              ArrowRight: [-80, 0],
              ArrowUp: [0, 80],
              ArrowDown: [0, -80],
            }
            if (pans[event.key]) {
              event.preventDefault()
              controls.current?.pan(...pans[event.key])
            } else if (['+', '=', '-'].includes(event.key)) {
              event.preventDefault()
              controls.current?.scale(event.key === '-' ? 1 / 1.5 : 1.5)
            } else if (['Home', 'Escape'].includes(event.key)) {
              event.preventDefault()
              choose(null)
            }
          }}
        >
          Use a busca para selecionar uma localidade.
        </canvas>

        <div className="pointer-events-none absolute top-5 right-5 left-5 flex flex-col items-start gap-2 sm:right-7 sm:left-7">
          <Breadcrumb
            aria-label="Localidade selecionada"
            className="pointer-events-auto rounded-md bg-background/90 px-2 py-1"
          >
            <BreadcrumbList>
              <BreadcrumbItem>
                {selected ? (
                  <Button variant="ghost" size="lg" onClick={() => choose(null)}>
                    {country.name}
                  </Button>
                ) : (
                  <BreadcrumbPage className="inline-flex min-h-8 items-center border border-transparent px-2.5 font-medium">
                    {country.name}
                  </BreadcrumbPage>
                )}
              </BreadcrumbItem>
              {state && (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    {selected && selected.type !== 'state' ? (
                      <Button variant="ghost" size="lg" onClick={() => choose(state)}>
                        {state.name}
                      </Button>
                    ) : (
                      <BreadcrumbPage className="inline-flex min-h-8 items-center border border-transparent px-2.5 font-medium">
                        {state.name}
                      </BreadcrumbPage>
                    )}
                  </BreadcrumbItem>
                </>
              )}
              {selected && selected.type !== 'state' && (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage className="inline-flex min-h-8 items-center border border-transparent px-2.5 font-medium">
                      {selected.name}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
        </div>

        <ResultsPanel
          election={election}
          selection={selected}
          state={state ?? null}
          countryName={country.name}
          codeLabel={country.codeLabel}
          data={data}
          notices={officeNotice ? [officeNotice] : []}
          desktop={desktop}
          onSelect={choose}
        />

        {hover && (
          <MapTooltip hover={hover}>
            {(() => {
              const target = hoverTarget(
                mapLayer,
                hover.area,
                data?.states.find((item) => item.properties.stateCode === hover.area.stateCode)
                  ?.properties.name,
              )
              return target && <MapHoverDetail target={target} />
            })()}
          </MapTooltip>
        )}

        {!ready && !error && <MapSkeleton outline={country.outline} />}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 p-6">
            <Card className="max-w-sm" role="alert">
              <CardHeader>
                <CardTitle>Mapa indisponível</CardTitle>
                <CardDescription>{error}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  onClick={() => {
                    retry()
                  }}
                >
                  Tentar novamente
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        <div
          className="absolute bottom-[calc(var(--panel-inset-bottom)+1.25rem)] left-5 flex flex-col gap-1 rounded-lg border bg-card p-1 shadow-sm sm:left-7"
          role="group"
          aria-label="Navegação do mapa"
        >
          <Button
            variant="ghost"
            size="icon-lg"
            className="size-10 pointer-coarse:size-11"
            aria-label="Aproximar mapa"
            title="Aproximar (+)"
            disabled={!ready || scale >= MAX_ZOOM}
            onClick={() => controls.current?.scale(1.5)}
          >
            <PlusIcon aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-lg"
            className="size-10 pointer-coarse:size-11"
            aria-label="Afastar mapa"
            title="Afastar (−)"
            disabled={!ready || scale <= 1.001}
            onClick={() => controls.current?.scale(1 / 1.5)}
          >
            <MinusIcon aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-lg"
            className="size-10 pointer-coarse:size-11"
            aria-label={`Enquadrar ${country.name}`}
            title={`Enquadrar ${country.name} (Home)`}
            disabled={!ready}
            onClick={() => choose(null)}
          >
            <ScanIcon aria-hidden="true" />
          </Button>
        </div>

        {(loadingDetails > 0 || detailError || locationMissing) && (
          <div
            className="absolute right-[calc(var(--panel-inset)+1.25rem)] bottom-[calc(var(--panel-inset-bottom)+6rem)] max-w-64 rounded-md bg-background/95 px-3 py-2 text-xs text-muted-foreground sm:right-[calc(var(--panel-inset)+1.75rem)]"
            role={detailError || locationMissing ? 'alert' : 'status'}
          >
            {locationMissing
              ? 'A localidade deste endereço não foi encontrada.'
              : detailError
                ? 'Não foi possível carregar alguns detalhes.'
                : 'Carregando detalhes…'}
            {detailError && (
              <Button
                variant="link"
                onClick={() => {
                  const stateCodes = retryDetails()
                  const request = selectionRequest.current
                  for (const stateCode of stateCodes)
                    void ensureDetails(stateCode)
                      .then(() => {
                        if (
                          request === selectionRequest.current &&
                          selected?.stateCode === stateCode
                        )
                          controls.current?.fit(selected.id)
                      })
                      .catch(() => {})
                }}
              >
                Tentar novamente
              </Button>
            )}
          </div>
        )}

        {ready && mapLayer.active && (
          <MapLegend
            layer={mapLayer}
            scopeLabel={(selected && state?.name) || country.name}
            focusArea={election.results.data?.area ?? null}
          />
        )}

        <footer className="pointer-events-none absolute right-5 bottom-[calc(var(--panel-inset-bottom)+1.25rem)] flex max-w-[calc(100%-6rem)] flex-col items-end gap-1 text-right text-xs text-muted-foreground sm:right-7">
          <p id={`map-instructions-${countryCode}`} className="sr-only">
            Use as setas para mover o mapa, + e − para ajustar o zoom e Home para voltar à visão do
            país. Use a busca para selecionar uma localidade.
          </p>
          {countryCode === 'US' && (
            <span className="rounded-md bg-background/90 px-2 py-1">
              Alasca e Havaí em quadros separados
            </span>
          )}
          <a
            className="pointer-events-auto rounded-md bg-background/90 px-2 py-1 underline-offset-4 hover:underline"
            href={country.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            {country.source} · {data?.year ?? 2025}
          </a>
        </footer>
        <p className="sr-only" role="status">
          {selected
            ? `${selected.name}, ${selected.stateAbbr}, selecionado.`
            : `Visão de ${country.name}.`}
        </p>
      </main>
    </div>
  )
}
