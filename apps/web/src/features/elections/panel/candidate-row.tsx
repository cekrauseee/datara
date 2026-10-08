import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'

import { photoURL } from '../api-client'
import { formatInteger, formatPercent, initials, MISSING, titleCase } from '../format'
import { partyLabel, type CandidateRowData } from './panel-model'

const OFFICIAL_DIFFERENCE = 0.05

/**
 * One candidate: colour stripe, photo with initials fallback, name, number and party, votes and
 * share, badges (most voted here, tie, official status with scope, vote destination) and a bar
 * proportional to the share. `null` values render as a dash.
 */
export function CandidateRow({
  row,
  position,
  leader,
  tie,
  statusScope,
}: {
  row: CandidateRowData
  /** Ranking position; omitted in the summary. */
  position: number | null
  leader: boolean
  tie: boolean
  statusScope: (areaId: string) => string
}) {
  const { candidate } = row
  const name = titleCase(candidate.displayName)
  const party = partyLabel(candidate.party)
  const share = row.share.value
  const official = row.officialPercentage
  const showOfficial =
    official !== null && (share === null || Math.abs(official.value - share) >= OFFICIAL_DIFFERENCE)
  const destination = row.voteDestination ?? candidate.voteDestination
  const voidDestination = destination !== null && destination !== 'Válido'

  return (
    <li
      className="flex gap-3 border-l-4 py-2 pl-3"
      style={{ borderLeftColor: candidate.color }}
      data-candidate-row={candidate.id}
    >
      <Avatar size="lg" className="mt-0.5">
        {candidate.photoUrl && <AvatarImage src={photoURL(candidate.photoUrl)} alt="" />}
        <AvatarFallback
          className="text-xs font-medium text-white"
          style={{ backgroundColor: candidate.color }}
        >
          {initials(candidate.displayName)}
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-sm font-medium">
            {position !== null && <span className="tabular-nums">{position}. </span>}
            {name}
          </p>
          <p className="shrink-0 text-sm font-medium tabular-nums" data-candidate-share="">
            {formatPercent(share)}
          </p>
        </div>
        <p className="text-muted-foreground">
          nº {candidate.number}
          {party && ` · ${party}`}
        </p>
        <p className="text-muted-foreground tabular-nums">
          {row.votes === null ? (
            <span title="não informado pela fonte">{MISSING}</span>
          ) : (
            `${formatInteger(row.votes)} votos`
          )}
          {showOfficial && official && (
            <span title={official.basis}> · oficial TSE {formatPercent(official.value)}</span>
          )}
        </p>
        {(leader || voidDestination || candidate.officialStatus) && (
          <p className="flex flex-wrap gap-1">
            {leader && <Badge>{tie ? 'Empate' : 'Mais votado aqui'}</Badge>}
            {candidate.officialStatus && (
              <Badge variant="secondary">
                {candidate.officialStatus} · {statusScope(candidate.officialStatusScopeAreaId)}
              </Badge>
            )}
            {voidDestination && <Badge variant="outline">{destination}</Badge>}
          </p>
        )}
        <div aria-hidden="true" className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.max(0, Math.min(100, share ?? 0))}%`,
              backgroundColor: candidate.color,
            }}
          />
        </div>
      </div>
    </li>
  )
}
