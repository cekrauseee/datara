import { cn } from 'cn'
import { XIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'

import { areaLabel, type Area, type MapViewData } from '../../map/map-data'
import { API_URL } from '../api-client'
import type { AreaResult, Candidate, Contest, Coverage } from '../api-types'
import { formatFocusPercent, inArea, LEVEL_BELOW } from '../candidate-focus'
import { OFFICE_CODES, type Metric, type OfficeKey } from '../election-location'
import { MAJORITARIAN_OFFICES, OFFICE_NAMES } from '../election-model'
import { formatDateTime, formatInteger, formatPercent, sourceKindLabel, titleCase } from '../format'
import { useCandidateFocus, type CandidateFocus } from '../use-candidate-focus'
import type { ElectionSnapshot } from '../use-election'
import { useElectionMap } from '../use-election-data'
import { navigateElection } from '../use-election-location'
import { ContestAreaList, OfficeAreaList } from './area-list'
import { CandidateCard, exitFocus } from './candidate-card'
import { CandidateDistribution } from './candidate-distribution'
import { CandidateList } from './candidate-list'
import { MobileSheet } from './mobile-sheet'
import { byName, contestScopeName, leaderOf, panelMode, scopeName, topCount } from './panel-model'
import { PanelEmpty, PanelError, PanelNotices, PanelSkeleton } from './panel-states'
import { TotalsBlock } from './totals'

export type ResultsPanelProps = {
  election: ElectionSnapshot
  /** Selected mesh area, or `null` for the country. */
  selection: Area | null
  /** State of the selection, from the mesh. */
  state: Area | null
  countryName: string
  codeLabel: string
  data: MapViewData | null
  /** Notices of the selectors (an office cleared for the new area). */
  notices: readonly string[]
  /** `sm+`: column on the right; otherwise the bottom sheet. */
  desktop: boolean
  onSelect: (area: Area | null) => void
}

/**
 * Results panel per level. Without an office it is the geographic selection card; with one, a
 * single skeleton serves country, state and municipality: title, coverage and provenance line,
 * summary or ranking, totals and the navigation list to the level below. The national view of a
 * per-state office lists the states with their leaders from the cross map. Desktop column or
 * mobile sheet, one variant at a time. The `data-election-*` attributes serve the browser checks.
 */
export function ResultsPanel({
  election,
  selection,
  state,
  countryName,
  codeLabel,
  data,
  notices,
  desktop,
  onSelect,
}: ResultsPanelProps) {
  const map = useElectionMap(election.mapRequest)
  const focus = useCandidateFocus(election.contest, election.candidate, election.areaId)
  const titleId = useId()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const focusTarget = useRef<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const selectionId = selection?.id ?? null
  useEffect(() => {
    if (focusTarget.current === null || focusTarget.current !== selectionId) return
    focusTarget.current = null
    titleRef.current?.focus()
  }, [selectionId])
  const navigate = (area: Area) => {
    focusTarget.current = area.id
    onSelect(area)
  }

  const office = election.active ? election.office : null
  if (!office)
    return (
      <>
        {selection && (
          <GeographyCard
            selection={selection}
            state={state}
            codeLabel={codeLabel}
            onClear={() => onSelect(null)}
          />
        )}
        {election.active && notices.length > 0 && (
          <div
            className="absolute top-20 right-5 left-5 text-xs/relaxed sm:left-auto sm:w-60"
            role="status"
          >
            <PanelNotices messages={notices} />
          </div>
        )}
      </>
    )

  const { results, contest, national } = election
  const error = election.error ?? results.error
  const loadingResults = results.status === 'loading'
  // The previous key may belong to another contest (office change in the same area): skeleton then.
  const previous = contest && results.previous?.contest.id === contest.id ? results.previous : null
  const current = results.data ?? (loadingResults ? previous : null)
  const stale = loadingResults && results.data === null && previous !== null
  const status = error
    ? 'error'
    : election.loading || loadingResults || map.status === 'loading'
      ? 'loading'
      : 'ready'
  const leaderRow = results.data ? leaderOf(results.data) : null
  const leaderAbbreviation = leaderRow?.candidate.party?.abbreviation
  const leaderText = leaderRow
    ? `${leaderRow.candidate.displayName}${leaderAbbreviation ? ` (${leaderAbbreviation})` : ''}`
    : ''
  const officeName = OFFICE_NAMES[office]
  const areaName = selection ? selection.name : countryName
  const title = selection ? `${selection.name} · ${areaLabel(selection)}` : countryName
  const subtitle = contest
    ? `${officeName} · ${contestScopeName(data, contest, results.data?.area ?? null)}`
    : national
      ? `${officeName} por UF`
      : officeName
  const mode = contest ? panelMode(contest) : null
  const allNotices = [...election.warnings, ...notices]
  const retryAll = () => {
    election.retry()
    if (results.status === 'error') results.retry()
    if (map.status === 'error') map.retry()
  }

  const statusText = error
    ? ''
    : focus?.here && focus.support
      ? `Foco em ${titleCase(focus.candidate.displayName)}: apoio ${formatFocusPercent(focus.support.value)} ${inArea(focus.here.area)}.`
      : election.loading || loadingResults
        ? `Carregando resultados de ${areaName}…`
        : national
          ? `${officeName} por UF: selecione um estado para ver a disputa.`
          : results.data?.state === 'unavailable'
            ? `Sem resultados para ${areaName} nesta publicação.`
            : results.data && mode === 'summary'
              ? leaderRow
                ? `Resultados de ${officeName} em ${areaName}: ${titleCase(leaderRow.candidate.displayName)} com ${formatPercent(leaderRow.share.value)}.`
                : `Resultados de ${officeName} em ${areaName}.`
              : results.data
                ? `Resultados de ${officeName} em ${areaName}: ${formatInteger(results.data.pagination.total)} candidatos.`
                : ''

  const attributes = {
    'data-election-status': status,
    'data-election-publication': election.publicationId ?? '',
    'data-election-contest': contest?.id ?? '',
    'data-election-area': election.areaId ?? '',
    'data-election-leader': leaderText,
    'data-election-results': results.data?.state ?? results.status,
    'data-election-map': map.status,
  }

  const states = data ? data.states.map((feature) => feature.properties).sort(byName) : []
  let body: React.ReactNode
  if (error) body = <PanelError error={error} onRetry={retryAll} />
  else if (election.session.status === 'empty')
    body = (
      <PanelEmpty
        title="Sem publicação disponível"
        description="Nenhuma eleição publicada para este turno."
      />
    )
  else if (election.areaStatus === 'missing')
    body = (
      <PanelEmpty
        title={`Sem resultados para ${areaName}`}
        description="Localidade sem área eleitoral nesta publicação."
      />
    )
  else if (national)
    body = (
      <NationalView
        office={office}
        coverage={election.coverage}
        states={states}
        onSelect={navigate}
      />
    )
  else if (contest && current)
    body = (
      <ContestBody
        result={current}
        contest={contest}
        coverage={election.coverage}
        selection={selection}
        areaName={areaName}
        data={data}
        states={states}
        stale={stale}
        onSelect={navigate}
        focus={focus}
        metric={election.state.metric}
        onFocus={(candidate) => toggleFocus(candidate, election.candidateId)}
      />
    )
  else body = <PanelSkeleton rows={contest ? topCount(contest) : 2} />

  const content = (
    <section aria-labelledby={titleId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <h2
            id={titleId}
            ref={titleRef}
            tabIndex={-1}
            className="font-heading text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {title}
          </h2>
          {selection && desktop && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Limpar seleção"
              onClick={() => onSelect(null)}
            >
              <XIcon aria-hidden="true" />
            </Button>
          )}
        </div>
        <p className="text-muted-foreground">{subtitle}</p>
      </div>
      <PanelNotices messages={allNotices} />
      {body}
    </section>
  )

  if (desktop)
    return (
      <Card
        size="sm"
        className="absolute top-20 right-5 flex max-h-[calc(100%-9rem)] w-80 flex-col gap-0 py-0 sm:right-7 lg:w-[22rem]"
        data-results-panel="column"
        {...attributes}
      >
        <div className="min-h-0 overflow-y-auto overscroll-contain p-(--card-spacing)">
          {content}
        </div>
        <p className="sr-only" role="status">
          {statusText}
        </p>
      </Card>
    )

  return (
    <MobileSheet
      label={`Resultados de ${officeName}`}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
      attributes={attributes}
      status={
        <p className="sr-only" role="status">
          {statusText}
        </p>
      }
      summary={
        <SheetSummary
          status={status}
          national={national}
          officeName={officeName}
          result={results.data}
          mode={mode}
          leader={leaderRow}
          focus={focus}
        />
      }
    >
      {content}
    </MobileSheet>
  )
}

function GeographyCard({
  selection,
  state,
  codeLabel,
  onClear,
}: {
  selection: Area
  state: Area | null
  codeLabel: string
  onClear: () => void
}) {
  return (
    <Card
      size="sm"
      className="absolute top-20 right-7 hidden w-60 sm:flex"
      data-results-panel="card"
    >
      <CardHeader>
        <CardTitle>{selection.name}</CardTitle>
        <CardDescription>
          {areaLabel(selection)}
          {selection.type !== 'state' && ` · ${state?.name}`}
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon" aria-label="Limpar seleção" onClick={onClear}>
            <XIcon aria-hidden="true" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-2">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Estado</dt>
            <dd>{selection.stateAbbr}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{codeLabel}</dt>
            <dd className="tabular-nums">{selection.geoid}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  )
}

function SheetSummary({
  status,
  national,
  officeName,
  result,
  mode,
  leader,
  focus,
}: {
  status: 'error' | 'loading' | 'ready'
  national: boolean
  officeName: string
  result: AreaResult | null
  mode: 'summary' | 'ranking' | null
  leader: AreaResult['candidates'][number] | null
  focus: CandidateFocus | null
}) {
  if (focus && status !== 'error')
    return (
      <>
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: focus.candidate.color }}
        />
        <span className="truncate font-medium">
          {titleCase(focus.candidate.displayName)} · nº {focus.candidate.number}
        </span>
        <span className="shrink-0 tabular-nums" data-sheet-focus-support="">
          {focus.support ? `Apoio ${formatFocusPercent(focus.support.value)}` : '…'}
        </span>
      </>
    )
  if (status === 'error')
    return <span className="truncate font-medium">Resultados indisponíveis</span>
  if (national) return <span className="truncate font-medium">{officeName} por UF</span>
  if (!result) return <span className="truncate text-muted-foreground">Carregando resultados…</span>
  if (result.state === 'unavailable')
    return <span className="truncate font-medium">Sem resultados nesta área</span>
  if (mode === 'summary' && leader)
    return (
      <>
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: leader.candidate.color }}
        />
        <span className="truncate font-medium">{titleCase(leader.candidate.displayName)}</span>
        <span className="shrink-0 tabular-nums">{formatPercent(leader.share.value)}</span>
      </>
    )
  return (
    <span className="truncate font-medium">
      {formatInteger(result.pagination.total)} candidatos · {officeName}
    </span>
  )
}

function CoverageLine({ result, coverage }: { result: AreaResult; coverage: Coverage | null }) {
  const scope = result.coverage.scope ?? coverage?.scope
  const totals = result.totals
  const provenance = result.provenance
  const items: React.ReactNode[] = []
  if (totals && (totals.sectionsCounted !== null || totals.sectionsTotal !== null))
    items.push(
      <span key="sections" className="tabular-nums">
        {formatInteger(totals.sectionsCounted)} de {formatInteger(totals.sectionsTotal)} seções
      </span>,
    )
  if (provenance)
    items.push(
      <span key="source" title={provenance.meaning}>
        {sourceKindLabel(provenance.sourceKind)}
      </span>,
    )
  if (provenance?.generatedAt)
    items.push(
      <span key="generated" className="tabular-nums">
        {formatDateTime(provenance.generatedAt)}
      </span>,
    )
  if (result.officialStatusLabel) items.push(<span key="status">{result.officialStatusLabel}</span>)
  provenance?.sourceIds.forEach((id, index) =>
    items.push(
      <a
        key={id}
        href={new URL(`/sources/${id}`, API_URL).href}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-4"
      >
        fonte{provenance.sourceIds.length > 1 ? ` ${index + 1}` : ''}
      </a>,
    ),
  )
  return (
    <p
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground"
      data-coverage=""
    >
      <Badge variant="outline">{scope === 'national' ? 'Nacional' : 'Piloto'}</Badge>
      {result.state === 'available' && !result.complete && (
        <Badge variant="secondary">Parcial</Badge>
      )}
      {items.map((item, index) => (
        <span key={index} className="contents">
          {index > 0 && <span aria-hidden="true">·</span>}
          {item}
        </span>
      ))}
    </p>
  )
}

function pilotDescription(coverage: Coverage | null): string {
  const selection = coverage?.scope === 'pilot' ? coverage.selection : null
  const base = selection
    ? `Piloto: ${selection.ufs.map((uf) => uf.toUpperCase()).join(', ')} · ${selection.municipalitiesPerUf} município(s) por UF.`
    : 'Área sem resultado publicado.'
  return `${base} Ausência de dado não é zero.`
}

function ContestBody({
  result,
  contest,
  coverage,
  selection,
  areaName,
  data,
  states,
  stale,
  onSelect,
  focus,
  metric,
  onFocus,
}: {
  result: AreaResult
  contest: Contest
  coverage: Coverage | null
  selection: Area | null
  areaName: string
  data: MapViewData | null
  states: Area[]
  stale: boolean
  onSelect: (area: Area) => void
  focus: CandidateFocus | null
  metric: Metric
  onFocus: (candidate: Candidate) => void
}) {
  const mode = panelMode(contest)
  const statusScope = (areaId: string) => scopeName(data, areaId, result)
  const focusLevel = focus ? (LEVEL_BELOW[result.area.level] ?? null) : null
  const meshAreas = useMemo(
    () =>
      new Map(
        data
          ? [...data.states, ...data.regions].map((feature) => [
              feature.properties.id,
              feature.properties,
            ])
          : [],
      ),
    [data],
  )
  const majoritarian = contest.voteType === 'majoritarian' && mode === 'summary'
  const municipalities =
    selection?.type === 'state' && data
      ? data.regions
          .map((feature) => feature.properties)
          .filter((area) => area.stateCode === selection.stateCode)
          .sort(byName)
      : []
  return (
    <div
      className={cn('flex flex-col gap-4', stale && 'opacity-60')}
      aria-busy={stale || undefined}
      data-contest-body={result.area.id}
    >
      {focus && (
        <>
          <CandidateCard focus={focus} metric={metric} statusScope={statusScope} />
          {focusLevel && (
            <CandidateDistribution
              key={`${focus.candidate.id}:${result.area.id}`}
              contestId={contest.id}
              candidateId={focus.candidate.id}
              areaId={result.area.id}
              level={focusLevel}
              placeLabel={inArea(result.area)}
              meshAreas={meshAreas}
              onSelect={onSelect}
            />
          )}
          <Separator />
        </>
      )}
      <CoverageLine result={result} coverage={coverage} />
      {result.state === 'unavailable' ? (
        <PanelEmpty
          title={`Sem resultados para ${areaName} nesta publicação`}
          description={pilotDescription(coverage)}
        />
      ) : (
        <>
          <CandidateList
            key={`${contest.id}:${result.area.id}`}
            result={result}
            contest={contest}
            mode={mode}
            statusScope={statusScope}
            focusedId={focus?.candidate.id ?? null}
            onFocus={onFocus}
          />
          <Separator />
          <TotalsBlock result={result} seats={contest.seats} />
        </>
      )}
      {!focus && selection === null && states.length > 0 && (
        <ContestAreaList
          heading="Estados"
          description={
            majoritarian ? 'Mais votado e vantagem em cada estado.' : 'Selecione um estado.'
          }
          areas={states}
          request={
            majoritarian
              ? { kind: 'contest', contestId: contest.id, level: 'state', metric: 'leader' }
              : null
          }
          onSelect={onSelect}
        />
      )}
      {!focus && selection?.type === 'state' && municipalities.length > 0 && (
        <ContestAreaList
          heading="Municípios"
          description={
            majoritarian ? 'Mais votado e vantagem em cada município.' : 'Selecione um município.'
          }
          areas={municipalities}
          request={
            majoritarian
              ? { kind: 'contest', contestId: contest.id, level: 'municipality', metric: 'leader' }
              : null
          }
          pageSize={40}
          onSelect={onSelect}
        />
      )}
    </div>
  )
}

function NationalView({
  office,
  coverage,
  states,
  onSelect,
}: {
  office: OfficeKey
  coverage: Coverage | null
  states: Area[]
  onSelect: (area: Area) => void
}) {
  const majoritarian = MAJORITARIAN_OFFICES.has(office)
  return (
    <div className="flex flex-col gap-4" data-national-view={OFFICE_CODES[office]}>
      <p className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
        <Badge variant="outline">{coverage?.scope === 'national' ? 'Nacional' : 'Piloto'}</Badge>
        <span>Selecione um estado para ver a disputa.</span>
      </p>
      <p className="text-muted-foreground" data-focus-national-note="">
        O foco em candidato vale dentro de uma disputa. Selecione uma UF para focar um candidato a{' '}
        {OFFICE_NAMES[office].toLocaleLowerCase('pt-BR')}.
      </p>
      <OfficeAreaList
        heading="Estados"
        description={
          majoritarian
            ? 'Mais votado e vantagem em cada estado, pelo mapa por cargo.'
            : 'Uma disputa por estado.'
        }
        areas={states}
        request={
          majoritarian
            ? { kind: 'office', officeCode: OFFICE_CODES[office], level: 'state', metric: 'leader' }
            : null
        }
        onSelect={onSelect}
      />
    </div>
  )
}

/**
 * Row click: enters the focus with the default metric (support, no `metric` token), switches the
 * candidate keeping the metric, or leaves the focus when the row is the focused candidate.
 */
function toggleFocus(candidate: Candidate, focusedId: string | null) {
  if (candidate.id === focusedId) exitFocus()
  else if (focusedId) navigateElection({ candidate: candidate.officialId })
  else navigateElection({ candidate: candidate.officialId, metric: 'share' })
}
