import { useCallback, useEffect, useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

import type { AreaResult, Contest } from '../api-types'
import { basisLabel, formatInteger, formatPercent, formatPoints } from '../format'
import { useResults } from '../use-election-data'
import { CandidateRow } from './candidate-row'
import {
  othersShare,
  partiesOf,
  topCount,
  type CandidateRowData,
  type PanelMode,
  type PartyInfo,
} from './panel-model'
import { PanelError } from './panel-states'
import { PartyTotals } from './party-totals'

type Tail = { offset: number; hasMore: boolean }

/**
 * Candidates of a result. Summary mode shows the top `seats + 1` with margin, seat cutoff and the
 * share of the others, expandable to the whole first page; ranking mode lists every row with its
 * position. Further pages come from `/results` by `offset`, one slot per page; party totals use
 * the labels of the rows loaded so far. Mount with a key per contest and area so the local state
 * resets with the result.
 */
export function CandidateList({
  result,
  contest,
  mode,
  statusScope,
}: {
  result: AreaResult
  contest: Contest
  mode: PanelMode
  statusScope: (areaId: string) => string
}) {
  const listId = useId()
  const [expanded, setExpanded] = useState(false)
  const [extraPages, setExtraPages] = useState(0)
  const [tail, setTail] = useState<Tail | null>(null)
  const [extraParties, setExtraParties] = useState<ReadonlyMap<string, PartyInfo>>(new Map())
  const onLoaded = useCallback((offset: number, rows: CandidateRowData[], hasMore: boolean) => {
    setTail((previous) => (previous && previous.offset > offset ? previous : { offset, hasMore }))
    setExtraParties((previous) => {
      const found = partiesOf(rows)
      let next: Map<string, PartyInfo> | null = null
      for (const [number, party] of found)
        if (!previous.has(number)) {
          next ??= new Map(previous)
          next.set(number, party)
        }
      return next ?? previous
    })
  }, [])

  const summary = result.summary
  const leaders = new Set(summary?.leaders ?? [])
  const tie = summary?.tie ?? false
  const limit = result.pagination.limit
  const total = result.pagination.total
  const top = topCount(contest)
  const collapsed = mode === 'summary' && !expanded
  const rows = collapsed ? result.candidates.slice(0, top) : result.candidates
  const others = collapsed ? othersShare(result, rows) : null
  const lastHasMore =
    extraPages === 0
      ? result.pagination.hasMore
      : tail !== null && tail.offset === extraPages * limit && tail.hasMore
  const proportional = contest.voteType === 'proportional'
  const parties = new Map([...partiesOf(result.candidates), ...extraParties])

  if (result.candidates.length === 0)
    return <p className="text-muted-foreground">Nenhuma candidatura publicada nesta área.</p>

  return (
    <section
      className="flex flex-col gap-3"
      aria-label={mode === 'summary' ? 'Mais votados' : 'Ranking de candidaturas'}
      data-candidate-list={mode}
    >
      <p className="text-muted-foreground">
        {mode === 'ranking' && `${formatInteger(total)} candidaturas · `}
        Percentuais {basisLabel(summary?.shareBasis)}
      </p>
      <ol id={listId} className="flex flex-col gap-1">
        {rows.map((row, index) => (
          <CandidateRow
            key={row.candidate.id}
            row={row}
            position={mode === 'ranking' || expanded ? result.pagination.offset + index + 1 : null}
            leader={leaders.has(row.candidate.id)}
            tie={tie}
            statusScope={statusScope}
          />
        ))}
        {!collapsed &&
          Array.from({ length: extraPages }, (_, index) => (
            <ExtraPage
              key={index + 1}
              contestId={contest.id}
              areaId={result.area.id}
              offset={(index + 1) * limit}
              limit={limit}
              leaders={leaders}
              tie={tie}
              statusScope={statusScope}
              onLoaded={onLoaded}
            />
          ))}
      </ol>
      {mode === 'summary' && summary && <MarginLines summary={summary} seats={contest.seats} />}
      {others !== null && (
        <p className="text-muted-foreground" data-others-share="">
          Outros {formatInteger(total - rows.length)} candidatos somam {formatPercent(others)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {mode === 'summary' && total > top && (
          <Button
            variant="outline"
            size="sm"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? `Mostrar só os ${top} primeiros` : `Ver todos os ${formatInteger(total)}`}
          </Button>
        )}
        {!collapsed && lastHasMore && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setExtraPages((value) => value + 1)}
            data-load-more=""
          >
            Carregar mais
          </Button>
        )}
      </div>
      {proportional && <PartyTotals parties={result.parties} dictionary={parties} />}
      {mode === 'ranking' && (
        <p className="text-muted-foreground">
          Vagas não são inferidas pelo ranking; a situação oficial vem do TSE.
        </p>
      )}
    </section>
  )
}

function MarginLines({
  summary,
  seats,
}: {
  summary: NonNullable<AreaResult['summary']>
  seats: number | null
}) {
  const { margin, seatCutoffMargin } = summary
  const marginText =
    margin.votes === null && margin.basis === 'unresolvedPrintedCandidateVotes'
      ? 'Vantagem indeterminada (votável não resolvido)'
      : margin.percentagePoints !== null
        ? `Vantagem ${formatPoints(margin.percentagePoints)}${margin.votes !== null ? ` · ${formatInteger(margin.votes)} votos` : ''}`
        : margin.votes !== null
          ? `Vantagem · ${formatInteger(margin.votes)} votos`
          : null
  const cutoffText =
    seats === 2 && seatCutoffMargin
      ? seatCutoffMargin.percentagePoints !== null
        ? `Corte da 2ª vaga: ${formatPoints(seatCutoffMargin.percentagePoints)}${seatCutoffMargin.votes !== null ? ` · ${formatInteger(seatCutoffMargin.votes)} votos` : ''}`
        : seatCutoffMargin.votes !== null
          ? `Corte da 2ª vaga: ${formatInteger(seatCutoffMargin.votes)} votos`
          : null
      : null
  if (!marginText && !cutoffText) return null
  return (
    <p className="flex flex-col gap-0.5 tabular-nums" data-margin="">
      {marginText && <span>{marginText}</span>}
      {cutoffText && <span data-seat-cutoff="">{cutoffText}</span>}
    </p>
  )
}

function ExtraPage({
  contestId,
  areaId,
  offset,
  limit,
  leaders,
  tie,
  statusScope,
  onLoaded,
}: {
  contestId: string
  areaId: string
  offset: number
  limit: number
  leaders: ReadonlySet<string>
  tie: boolean
  statusScope: (areaId: string) => string
  onLoaded: (offset: number, rows: CandidateRowData[], hasMore: boolean) => void
}) {
  const query = useResults(contestId, areaId, { limit, offset })
  const data = query.data
  useEffect(() => {
    if (data) onLoaded(offset, data.candidates, data.pagination.hasMore)
  }, [data, offset, onLoaded])
  if (query.status === 'error' && query.error)
    return (
      <li className="py-2">
        <PanelError error={query.error} onRetry={query.retry} />
      </li>
    )
  if (!data)
    return (
      <li className="flex flex-col gap-3 py-2" aria-busy="true">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </li>
    )
  return data.candidates.map((row, index) => (
    <CandidateRow
      key={row.candidate.id}
      row={row}
      position={data.pagination.offset + index + 1}
      leader={leaders.has(row.candidate.id)}
      tie={tie}
      statusScope={statusScope}
    />
  ))
}
