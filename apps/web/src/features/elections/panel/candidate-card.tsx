import { XIcon } from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

import { photoURL } from '../api-client'
import type { Candidate } from '../api-types'
import {
  formatFocusPercent,
  inArea,
  toArea,
  type AreaVotes,
  type FocusMeasure,
} from '../candidate-focus'
import type { Metric } from '../election-location'
import { basisLabel, formatInteger, initials, sourceKindLabel, titleCase } from '../format'
import type { CandidateFocus } from '../use-candidate-focus'
import { navigateElection } from '../use-election-location'
import { MetricToggle } from './metric-toggle'
import { PanelError } from './panel-states'

const ROLES: Record<Candidate['runningMates'][number]['role'], string> = {
  vice: 'Vice',
  firstSubstitute: '1º suplente',
  secondSubstitute: '2º suplente',
  unknown: 'Chapa',
}

/** Leaves the focus: no candidate and the default metric (no token). */
export function exitFocus() {
  navigateElection({ candidate: null, metric: 'leader' })
}

/**
 * Card of the focused candidate, at the top of the panel: identity, coalition, federation,
 * running mates and official status; support and contribution in the selected area with their
 * bases or the reason they are missing; the map metric toggle.
 */
export function CandidateCard({
  focus,
  metric,
  statusScope,
}: {
  focus: CandidateFocus
  metric: Metric
  statusScope: (areaId: string) => string
}) {
  const { candidate } = focus
  const name = titleCase(candidate.displayName)
  const party = candidate.party
  const coalition = party && candidate.coalition?.type === 'coalition' ? candidate.coalition : null
  const federation = party ? candidate.federation : null
  const destination = candidate.voteDestination
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border p-3"
      style={{ borderLeftColor: candidate.color, borderLeftWidth: 4 }}
      aria-label={`Foco em ${name}`}
      data-candidate-card={candidate.officialId}
    >
      <div className="flex items-start gap-3">
        <Avatar size="lg" className="mt-0.5">
          {candidate.photoUrl && <AvatarImage src={photoURL(candidate.photoUrl)} alt="" />}
          <AvatarFallback
            className="text-xs font-medium text-white"
            style={{ backgroundColor: candidate.color }}
          >
            {initials(candidate.displayName)}
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="font-heading text-sm font-medium" data-candidate-card-name="">
            {name}
          </p>
          <p className="text-muted-foreground">
            nº {candidate.number}
            {party && ` · ${party.displayName ?? party.abbreviation}`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={exitFocus} data-exit-focus="">
          <XIcon aria-hidden="true" />
          Sair do foco
        </Button>
      </div>
      {(coalition || federation || candidate.runningMates.length > 0) && (
        <ul className="flex flex-col gap-0.5 text-muted-foreground">
          {coalition && (
            <li>
              Coligação: {titleCase(coalition.name)} — {coalition.composition}
            </li>
          )}
          {federation && <li>Federação: {federation.abbreviation}</li>}
          {candidate.runningMates.map((mate) => (
            <li key={mate.officialId}>
              {ROLES[mate.role]}: {titleCase(mate.displayName)}
              {mate.partyAbbreviation && ` (${mate.partyAbbreviation})`}
            </li>
          ))}
        </ul>
      )}
      {(candidate.officialStatus || (destination && destination !== 'Válido')) && (
        <p className="flex flex-wrap gap-1">
          {candidate.officialStatus && (
            <Badge variant="secondary">
              {candidate.officialStatus} · {statusScope(candidate.officialStatusScopeAreaId)}
            </Badge>
          )}
          {destination && destination !== 'Válido' && (
            <Badge variant="outline">{destination}</Badge>
          )}
        </p>
      )}
      <FocusMeasures focus={focus} name={name} />
      <MetricToggle metric={metric} />
    </section>
  )
}

function FocusMeasures({ focus, name }: { focus: CandidateFocus; name: string }) {
  if (focus.status === 'error' && focus.error)
    return <PanelError error={focus.error} onRetry={focus.retry} />
  const { here } = focus
  if (!here || !focus.support)
    return (
      <p className="text-muted-foreground" aria-busy="true">
        Calculando apoio e contribuição…
      </p>
    )
  return (
    <dl className="flex flex-col gap-1.5 tabular-nums" data-focus-measures="">
      <Measure
        label={`Apoio ${inArea(here.area)}`}
        measure={focus.support}
        detail={(measure) =>
          `${formatInteger(measure.numerator)} de ${formatInteger(measure.denominator)} ${basisLabel(measure.basis)}`
        }
        source={here}
        attribute="data-focus-support"
      />
      {focus.atScope ? (
        <div data-focus-contribution="100">
          <dt className="inline">Contribuição: </dt>
          <dd className="inline">escopo da disputa (100%)</dd>
        </div>
      ) : focus.parent && focus.contribution ? (
        <Measure
          label={`Contribuição ${toArea(focus.parent.area)}`}
          measure={focus.contribution}
          detail={(measure) =>
            `${formatInteger(measure.numerator)} de ${formatInteger(measure.denominator)} votos de ${name}`
          }
          attribute="data-focus-contribution"
        />
      ) : (
        <p className="text-muted-foreground" aria-busy="true">
          Calculando contribuição…
        </p>
      )}
      {focus.scope && focus.scopeContribution && (
        <Measure
          label={`Contribuição ${inArea(focus.scope.area)}`}
          measure={focus.scopeContribution}
          detail={(measure) =>
            `${formatInteger(measure.numerator)} de ${formatInteger(measure.denominator)} votos de ${name}`
          }
          attribute="data-focus-scope-contribution"
        />
      )}
      {!here.complete && here.resultState === 'available' && (
        <p className="text-muted-foreground">
          Totalização parcial {inArea(here.area)}; valores podem mudar.
        </p>
      )}
    </dl>
  )
}

function Measure({
  label,
  measure,
  detail,
  source,
  attribute,
}: {
  label: string
  measure: FocusMeasure
  detail: (measure: FocusMeasure) => string
  source?: AreaVotes
  attribute: string
}) {
  const kind = source?.sourceKind ?? null
  return (
    <div {...{ [attribute]: measure.value ?? '' }} data-votes={measure.numerator ?? ''}>
      <dt className="inline">{label}: </dt>
      <dd className="inline">
        <span className="font-medium">{formatFocusPercent(measure.value)}</span>
        {measure.state === 'available' ? (
          <span className="text-muted-foreground">
            {' · '}
            {detail(measure)}
            {kind && !detail(measure).endsWith(`(${kind})`) && (
              <span title={sourceKindLabel(kind)}> ({kind})</span>
            )}
          </span>
        ) : (
          measure.reason && <span className="block text-muted-foreground">{measure.reason}</span>
        )}
      </dd>
    </div>
  )
}
