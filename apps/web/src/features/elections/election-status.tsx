import { Button } from '@/components/ui/button'

import type { AreaResult } from './api-types'
import { OFFICE_NAMES } from './election-model'
import type { ElectionSnapshot } from './use-election'
import { useElectionMap } from './use-election-data'

const percent = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })

function leaderOf(result: AreaResult) {
  const id = result.summary?.leaders[0]
  if (!id) return null
  const row = result.candidates.find((entry) => entry.candidate.id === id)
  if (!row) return { name: id, share: null }
  return {
    name: `${row.candidate.displayName}${row.candidate.party ? ` (${row.candidate.party.abbreviation})` : ''}`,
    share: row.share.value,
  }
}

/**
 * Provisional status block proving the flow (publication, contest, area, leader); module 5
 * replaces it with the results panel. Attributes `data-election-*` serve the browser check.
 */
export function ElectionStatus({ election }: { election: ElectionSnapshot }) {
  const { results } = election
  const map = useElectionMap(election.mapRequest)
  const error = election.error ?? results.error ?? map.error
  const leader = results.data ? leaderOf(results.data) : null
  const loading = election.loading || results.status === 'loading' || map.status === 'loading'
  const retry = () => {
    election.retry()
    if (results.status === 'error') results.retry()
    if (map.status === 'error') map.retry()
  }
  const publication = election.publicationId
  const coverage = election.coverage
  return (
    <div
      className="pointer-events-auto flex max-w-sm flex-col gap-1 rounded-md bg-background/90 px-3 py-2 text-xs"
      data-election-status={error ? 'error' : loading ? 'loading' : 'ready'}
      data-election-publication={publication ?? ''}
      data-election-contest={election.contest?.id ?? ''}
      data-election-area={election.areaId ?? ''}
      data-election-leader={leader?.name ?? ''}
      data-election-results={results.data?.state ?? results.status}
      data-election-map={map.status}
    >
      <p>
        <span className="text-muted-foreground">Publicação</span>{' '}
        {publication ? (
          <span className="tabular-nums">
            {publication.slice(0, 8)} · {coverage?.scope === 'national' ? 'nacional' : 'piloto'}
          </span>
        ) : election.session.status === 'loading' ? (
          'resolvendo…'
        ) : (
          '—'
        )}
      </p>
      <p>
        <span className="text-muted-foreground">Disputa</span>{' '}
        {election.contest
          ? `${election.contest.id} · ${election.contest.officeName}`
          : election.national && election.office
            ? `${OFFICE_NAMES[election.office]} por UF (mapa cruzado)`
            : election.office
              ? '—'
              : 'selecione um cargo'}
      </p>
      <p>
        <span className="text-muted-foreground">Área</span>{' '}
        <span className="tabular-nums">{election.areaId ?? '…'}</span>
      </p>
      {election.resultsRequest && (
        <p>
          <span className="text-muted-foreground">Mais votado</span>{' '}
          {leader
            ? `${leader.name}${leader.share !== null ? ` · ${percent.format(leader.share)}%` : ''}`
            : results.data
              ? results.data.state === 'available'
                ? 'indeterminado'
                : 'sem resultados nesta área'
              : results.status === 'error'
                ? 'indisponível'
                : 'carregando…'}
        </p>
      )}
      {election.mapRequest && (
        <p>
          <span className="text-muted-foreground">Mapa</span>{' '}
          {map.data
            ? `${map.data.items.length} áreas · ${map.data.level} · ${map.data.metric}`
            : map.status === 'error'
              ? 'indisponível'
              : 'carregando…'}
        </p>
      )}
      {election.warnings.length > 0 && (
        <ul className="list-disc pl-4 text-muted-foreground" data-election-warnings="">
          {election.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" data-election-error={error.code}>
          {error.message}
          {error.requestId && (
            <span className="text-muted-foreground"> · {error.requestId.slice(0, 8)}</span>
          )}{' '}
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={retry}>
            Tentar novamente
          </Button>
        </p>
      )}
    </div>
  )
}
