import type { ApiClientError } from './api-client'
import type { Candidate, Contest } from './api-types'
import {
  areaVotes,
  contributionOf,
  LEVEL_BELOW,
  needsDistribution,
  parentAreaId,
  supportOf,
  type AreaVotes,
  type FocusMeasure,
} from './candidate-focus'
import { useDistribution, useResults } from './use-election-data'

type AreaVotesQuery = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  value: AreaVotes | null
  error: ApiClientError | null
  retry: () => void
}

/**
 * The candidate's votes in one area: `/results` of the area (shared with the panel's slot), and
 * `/distribution?limit=1` below it only when the row is not on the loaded page.
 */
function useAreaVotes(
  contestId: string | null,
  candidateId: string | null,
  areaId: string | null,
): AreaVotesQuery {
  const enabled = !!contestId && !!candidateId && !!areaId
  const results = useResults(enabled ? contestId : null, enabled ? areaId : null)
  const result = results.data
  const level =
    enabled && result && needsDistribution(result, candidateId!)
      ? (LEVEL_BELOW[result.area.level] ?? null)
      : null
  const distribution = useDistribution(level ? contestId : null, candidateId, areaId, level, null, {
    limit: 1,
  })
  if (!enabled) return { status: 'idle', value: null, error: null, retry: () => {} }
  const error = results.error ?? (level ? distribution.error : null)
  if (error)
    return {
      status: 'error',
      value: null,
      error,
      retry: () => {
        if (results.status === 'error') results.retry()
        if (distribution.status === 'error') distribution.retry()
      },
    }
  if (!result || (level && !distribution.data))
    return { status: 'loading', value: null, error: null, retry: () => {} }
  return {
    status: 'ready',
    value: areaVotes(result, candidateId!, level ? distribution.data : null),
    error: null,
    retry: () => {},
  }
}

export type CandidateFocus = {
  status: 'loading' | 'ready' | 'error'
  error: ApiClientError | null
  retry: () => void
  candidate: Candidate
  contest: Contest
  /** The selected area. */
  here: AreaVotes | null
  support: FocusMeasure | null
  /** Enclosing area of the contribution, `null` at the contest's scope area. */
  parent: AreaVotes | null
  contribution: FocusMeasure | null
  /** Contest scope (Brazil or the state) when it differs from the parent. */
  scope: AreaVotes | null
  scopeContribution: FocusMeasure | null
  /** The selected area is the contest's scope: contribution is 100 % by definition. */
  atScope: boolean
}

/** Support and contribution of the focused candidate in the selected area. */
export function useCandidateFocus(
  contest: Contest | null,
  candidate: Candidate | null,
  areaId: string | null,
): CandidateFocus | null {
  const contestId = contest && candidate ? contest.id : null
  const candidateId = candidate?.id ?? null
  const hereQuery = useAreaVotes(contestId, candidateId, areaId)
  const here = hereQuery.value
  const scopeId = contest?.scopeAreaId ?? null
  const atScope = !!areaId && areaId === scopeId
  const parentId = here && !atScope ? parentAreaId(here.area) : null
  const parentQuery = useAreaVotes(contestId, candidateId, parentId)
  const scopeQuery = useAreaVotes(
    contestId,
    candidateId,
    parentId && parentId !== scopeId ? scopeId : null,
  )
  if (!contest || !candidate) return null
  const queries = [hereQuery, parentQuery, scopeQuery]
  const failed = queries.find((query) => query.status === 'error')
  const parent = parentQuery.value
  const scope = scopeQuery.value
  return {
    status: failed ? 'error' : queries.some((q) => q.status === 'loading') ? 'loading' : 'ready',
    error: failed?.error ?? null,
    retry: () => queries.forEach((query) => query.retry()),
    candidate,
    contest,
    here,
    support: here ? supportOf(here) : null,
    parent,
    contribution: here && parent ? contributionOf(here, parent) : null,
    scope,
    scopeContribution: here && scope ? contributionOf(here, scope) : null,
    atScope,
  }
}
