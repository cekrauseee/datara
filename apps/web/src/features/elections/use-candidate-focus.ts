import { useEffect, useState } from 'react'

import type { ApiClientError } from './api-client'
import type { AreaResult, Candidate, Contest } from './api-types'
import {
  areaVotes,
  contributionOf,
  LEVEL_BELOW,
  needsDistribution,
  needsListing,
  parentAreaId,
  supportOf,
  type AreaVotes,
  type FocusMeasure,
  type RowLookup,
} from './candidate-focus'
import { useDistribution, useResults } from './use-election-data'

type AreaVotesQuery = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  value: AreaVotes | null
  error: ApiClientError | null
  retry: () => void
}

const LISTING_LIMIT = 100
/** Pages read at most (2.000 rows, beyond any section) before the votes are undetermined. */
const LISTING_PAGES = 20

type ListingQuery = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  lookup: RowLookup | null
  error: ApiClientError | null
  retry: () => void
}

/**
 * Further `/results` pages of an area with no level below (a section), read one after another
 * until the candidate's row appears or the list ends.
 */
function useListedRow(
  contestId: string | null,
  candidateId: string | null,
  result: AreaResult | null,
): ListingQuery {
  const active = !!contestId && !!candidateId && !!result && needsListing(result, candidateId)
  const key = active ? `${contestId}:${result.area.id}:${candidateId}` : null
  const [cursor, setCursor] = useState<{ key: string | null; page: number }>({
    key: null,
    page: 0,
  })
  const page = cursor.key === key ? cursor.page : 0
  const start = result ? result.pagination.offset + result.candidates.length : 0
  const query = useResults(active ? contestId : null, active ? result.area.id : null, {
    limit: LISTING_LIMIT,
    offset: start + page * LISTING_LIMIT,
  })
  const data = query.data
  const row = data?.candidates.find((item) => item.candidate.id === candidateId) ?? null
  const more = !!data && !row && data.pagination.hasMore
  const next = more && page + 1 < LISTING_PAGES
  useEffect(() => {
    if (next) setCursor({ key, page: page + 1 })
  }, [next, key, page])
  if (!active) return { status: 'idle', lookup: null, error: null, retry: () => {} }
  if (query.error) return { status: 'error', lookup: null, error: query.error, retry: query.retry }
  if (!data || next) return { status: 'loading', lookup: null, error: null, retry: () => {} }
  return { status: 'ready', lookup: { row, complete: !more }, error: null, retry: () => {} }
}

/**
 * The candidate's votes in one area: `/results` of the area (shared with the panel's slot), and
 * when the row is not on the loaded page, `/distribution?limit=1` below it or, with no level
 * below, the further `/results` pages.
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
  const listing = useListedRow(enabled ? contestId : null, candidateId, enabled ? result : null)
  if (!enabled) return { status: 'idle', value: null, error: null, retry: () => {} }
  const error = results.error ?? (level ? distribution.error : null) ?? listing.error
  if (error)
    return {
      status: 'error',
      value: null,
      error,
      retry: () => {
        if (results.status === 'error') results.retry()
        if (distribution.status === 'error') distribution.retry()
        if (listing.status === 'error') listing.retry()
      },
    }
  if (!result || (level && !distribution.data) || listing.status === 'loading')
    return { status: 'loading', value: null, error: null, retry: () => {} }
  return {
    status: 'ready',
    value: areaVotes(result, candidateId!, level ? distribution.data : null, listing.lookup),
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
