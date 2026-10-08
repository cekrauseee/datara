import { cached } from './api-cache'
import { ApiClientError, apiRequest, apiURL, isApiError, type ApiParams } from './api-client'
import type {
  AreaLevel,
  AreaList,
  AreaResult,
  Candidate,
  CandidateList,
  ContestList,
  DistributionLevel,
  DistributionResponse,
  DistributionSort,
  ElectionMapResponse,
  ElectoralArea,
  MapLevel,
  MapResponse,
  OfficeMapMetric,
} from './api-types'
import type { ContestMapRequest, MapRequest, OfficeMapRequest } from './election-model'
import { repinAfterNotFound, useSession } from './election-session'
import { useApiQuery, type ApiQuery } from './use-api-query'

export type Page = { limit?: number; offset?: number }

// Every slot request carries the effective publicationId and goes through the session cache.
async function loadPublished<T>(url: string): Promise<T> {
  try {
    return await cached(url, () => apiRequest<T>(url))
  } catch (error) {
    if (isApiError(error, 404, 'PUBLICATION_NOT_FOUND')) {
      const publicationId = new URL(url).searchParams.get('publicationId')
      if (publicationId && (await repinAfterNotFound(publicationId)))
        throw new ApiClientError({
          status: 0,
          code: 'SUPERSEDED',
          message: 'A publicação ativa mudou; os dados serão recarregados.',
        })
    }
    throw error
  }
}

function usePublished<T>(
  route: ((editionId: string) => string) | null,
  params: ApiParams = {},
): ApiQuery<T> {
  const session = useSession()
  const key =
    route && session.status === 'ready'
      ? apiURL(route(session.edition.id), { ...params, publicationId: session.publicationId })
      : null
  return useApiQuery<T>(key, loadPublished)
}

/** All contests of the edition, loaded once per publication. */
export function useContests(enabled = true): ApiQuery<ContestList> {
  return usePublished<ContestList>(enabled ? (id) => `/elections/${id}/contests` : null)
}

export type ElectoralAreaQuery = {
  status: 'idle' | 'loading' | 'ready' | 'missing' | 'error'
  area: ElectoralArea | null
  error: ApiClientError | null
  retry: () => void
}

/** Electoral area of an IBGE feature (2-digit state or 7-digit municipality code). */
export function useElectoralArea(featureId: string | null): ElectoralAreaQuery {
  const query = usePublished<AreaList>(featureId ? (id) => `/elections/${id}/areas` : null, {
    featureId,
  })
  const area = query.data?.items[0] ?? null
  return {
    status: query.status === 'ready' && !area ? 'missing' : query.status,
    area,
    error: query.error,
    retry: query.retry,
  }
}

/** Child areas (zones, sections, exterior localities, regions), paginated. */
export function useAreas(
  parentId: string | null,
  level: AreaLevel | null = null,
  page: Page = {},
): ApiQuery<AreaList> {
  return usePublished<AreaList>(parentId ? (id) => `/elections/${id}/areas` : null, {
    parentId,
    level,
    ...page,
  })
}

/** Map values of one contest: `(contestId, level, metric, candidateId[, areaId])`. */
export function useContestMap(request: ContestMapRequest | null): ApiQuery<MapResponse> {
  return usePublished<MapResponse>(
    request ? () => `/contests/${request.contestId}/map` : null,
    request
      ? {
          level: request.level,
          metric: request.metric,
          candidateId: request.candidateId,
          areaId: request.areaId,
        }
      : {},
  )
}

/** Cross map by office for the national view of per-state offices. */
export function useOfficeMap(request: OfficeMapRequest | null): ApiQuery<ElectionMapResponse> {
  return usePublished<ElectionMapResponse>(
    request ? (id) => `/elections/${id}/map` : null,
    request ? { officeCode: request.officeCode, level: request.level, metric: request.metric } : {},
  )
}

/** Either map slot, chosen by the request kind. */
export function useElectionMap(
  request: MapRequest | null,
): ApiQuery<MapResponse | ElectionMapResponse> {
  const contest = useContestMap(request?.kind === 'contest' ? request : null)
  const office = useOfficeMap(request?.kind === 'office' ? request : null)
  return request?.kind === 'office' ? office : contest
}

/** Result of a contest in an area (the most specific one: zone and section included). */
export function useResults(
  contestId: string | null,
  areaId: string | null,
  page: Page = {},
): ApiQuery<AreaResult> {
  return usePublished<AreaResult>(
    contestId && areaId ? () => `/contests/${contestId}/results` : null,
    { areaId, ...page },
  )
}

export type CandidateQuery = {
  status: 'idle' | 'loading' | 'ready' | 'missing' | 'error'
  candidate: Candidate | null
  error: ApiClientError | null
  retry: () => void
}

/** Candidate of a contest by `officialId` (the URL `candidate` value). */
export function useCandidate(contestId: string | null, officialId: string | null): CandidateQuery {
  const query = usePublished<CandidateList>(
    contestId && officialId ? () => `/contests/${contestId}/candidates` : null,
    { officialId },
  )
  const candidate = query.data?.items[0] ?? null
  return {
    status: query.status === 'ready' && !candidate ? 'missing' : query.status,
    candidate,
    error: query.error,
    retry: query.retry,
  }
}

/** Candidates of a contest, paginated and optionally filtered. */
export function useCandidates(
  contestId: string | null,
  page: Page = {},
  filter: { q?: string; partyNumber?: string } = {},
): ApiQuery<CandidateList> {
  return usePublished<CandidateList>(contestId ? () => `/contests/${contestId}/candidates` : null, {
    ...filter,
    ...page,
  })
}

/** Territorial distribution of a candidate's votes below an area. */
export function useDistribution(
  contestId: string | null,
  candidateId: string | null,
  areaId: string | null,
  level: DistributionLevel | null = null,
  sort: DistributionSort | null = null,
  page: Page = {},
): ApiQuery<DistributionResponse> {
  return usePublished<DistributionResponse>(
    contestId && candidateId ? () => `/contests/${contestId}/distribution` : null,
    { candidateId, areaId, level, sort, ...page },
  )
}

export type { MapLevel, OfficeMapMetric }
