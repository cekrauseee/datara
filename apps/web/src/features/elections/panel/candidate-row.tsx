import { cn } from 'cn'

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
  selected = false,
  onSelect,
}: {
  row: CandidateRowData
  /** Ranking position; omitted in the summary. */
  position: number | null
  leader: boolean
  tie: boolean
  statusScope: (areaId: string) => string
  /** Focused candidate: the row reads as pressed. */
  selected?: boolean
  /** Enters (or, when selected, leaves) the candidate focus. */
  onSelect?: () => void
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
      className="border-l-4"
      style={{ borderLeftColor: candidate.color }}
      data-candidate-row={candidate.id}
    >
      <RowShell selected={selected} onSelect={onSelect} label={name}>
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
          {share !== null && (
            <div aria-hidden="true" className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(0, Math.min(100, share))}%`,
                  backgroundColor: candidate.color,
                }}
              />
            </div>
          )}
        </div>
      </RowShell>
    </li>
  )
}

/** A pressed-state button when the row is selectable, otherwise a plain container. */
function RowShell({
  selected,
  onSelect,
  label,
  children,
}: {
  selected: boolean
  onSelect?: () => void
  label: string
  children: React.ReactNode
}) {
  const className = 'flex w-full gap-3 py-2 pl-3 text-left'
  if (!onSelect) return <div className={className}>{children}</div>
  return (
    <button
      type="button"
      className={cn(
        className,
        'rounded-r-md pr-1 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
        selected && 'bg-muted',
      )}
      aria-pressed={selected}
      title={selected ? `Sair do foco em ${label}` : `Focar em ${label}`}
      onClick={onSelect}
    >
      {children}
    </button>
  )
}
