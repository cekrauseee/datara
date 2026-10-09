import { useId } from 'react'

import type { AreaResult } from '../api-types'
import { aggregateCoverage, REGION_ORDER, regionName } from '../depth'
import { formatInteger, formatPercent, titleCase } from '../format'
import { useResults } from '../use-election-data'
import { errorMessage, leaderOf, partyLabel } from './panel-model'

const ROWS = [...REGION_ORDER, 'exterior'] as const

/**
 * "Regiões e exterior" in the national president panel: one `/results` request per row, in
 * parallel and cached by URL (the same key the panel requests when the row is chosen). Regions
 * are sums of the domestic states (exterior excluded); the exterior is an EA20 total.
 */
export function NationalRows({
  contestId,
  onSelect,
}: {
  contestId: string
  onSelect: (areaId: string) => void
}) {
  const headingId = useId()
  return (
    <section className="flex flex-col gap-2" aria-labelledby={headingId} data-national-rows="">
      <h3 id={headingId} className="text-sm font-medium">
        Regiões e exterior
      </h3>
      <p className="text-muted-foreground">
        Regiões somam os estados (sem o exterior); o exterior não tem geometria no mapa.
      </p>
      <ol className="flex flex-col">
        {ROWS.map((areaId) => (
          <NationalRow key={areaId} contestId={contestId} areaId={areaId} onSelect={onSelect} />
        ))}
      </ol>
    </section>
  )
}

function coverageText(result: AreaResult): string | null {
  if (result.provenance?.sourceKind === 'aggregate') {
    const states = aggregateCoverage(result.provenance.meaning)
    return [states ? `soma das UFs (${states})` : 'soma das UFs', result.officialStatusLabel]
      .filter(Boolean)
      .join(' · ')
  }
  const totals = result.totals
  if (totals && (totals.sectionsCounted !== null || totals.sectionsTotal !== null))
    return `${formatInteger(totals.sectionsCounted)} de ${formatInteger(totals.sectionsTotal)} seções`
  return result.officialStatusLabel
}

function NationalRow({
  contestId,
  areaId,
  onSelect,
}: {
  contestId: string
  areaId: string
  onSelect: (areaId: string) => void
}) {
  const query = useResults(contestId, areaId)
  const result = query.data
  const name = areaId === 'exterior' ? 'Exterior' : regionName(result?.area ?? areaId)
  const leader = result && result.state !== 'unavailable' ? leaderOf(result) : null
  const party = leader ? partyLabel(leader.candidate.party) : null
  const detail =
    query.status === 'error' && query.error
      ? errorMessage(query.error)
      : !result
        ? 'Carregando…'
        : result.state === 'unavailable'
          ? 'sem dados nesta publicação'
          : coverageText(result)
  return (
    <li className="border-t border-border/60 first:border-t-0">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        onClick={() => onSelect(areaId)}
        data-national-row={areaId}
      >
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full bg-muted-foreground/30"
          style={leader ? { backgroundColor: leader.candidate.color } : undefined}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            {name}
            {leader && (
              <span className="text-muted-foreground">
                {' · '}
                {titleCase(leader.candidate.displayName)}
                {party ? ` (${party})` : ''}
              </span>
            )}
          </span>
          {detail && (
            <span className="block truncate text-muted-foreground" data-national-coverage="">
              {detail}
            </span>
          )}
        </span>
        {leader && (
          <span className="shrink-0 tabular-nums">{formatPercent(leader.share.value)}</span>
        )}
      </button>
    </li>
  )
}
