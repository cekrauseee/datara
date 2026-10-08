import { useEffect, useState } from 'react'

import type { CountryCode } from '../map/map-countries'
import type { ApiClientError } from './api-client'
import type { AreaResult, Candidate, Contest, Coverage, Election, ElectoralArea } from './api-types'
import {
  AREA_OFFICE_NOTICE,
  areaAllowed,
  areaKind,
  sectionNotFound,
  zoneNotFound,
  type DepthKind,
} from './depth'
import type { ElectionState, OfficeKey } from './election-location'
import {
  availableOffices,
  deriveContest,
  deriveMapRequest,
  isNationalOffice,
  OFFICE_NAMES,
  specificAreaId,
  type MapRequest,
  type OfficeAvailability,
} from './election-model'
import { retrySession, useElectionSession, type SessionState } from './election-session'
import type { ApiQuery } from './use-api-query'
import { useDepth, type DepthResolution } from './use-area-list'
import { useCandidate, useContests, useElectoralArea, useResults } from './use-election-data'
import { navigateElection, useElectionLocation } from './use-election-location'

export type ElectionSnapshot = {
  /** Brazil view with the elections collection selected. */
  active: boolean
  state: ElectionState
  session: SessionState
  edition: Election | null
  publicationId: string | null
  coverage: Coverage | null
  contests: Contest[] | null
  /** Offices selectable for the current area, in display order. */
  offices: OfficeAvailability[]
  /** Electoral area of the geography or `area` parameter: `br`, `ac`, `ac:01392`, `exterior`… */
  baseAreaId: string | null
  /** Most specific area: zone and section appended to the municipality. */
  areaId: string | null
  /** Kind of the `area` parameter in effect (exterior, locality, region), or `null`. */
  areaKind: DepthKind | null
  /** Zone and section of the URL resolved against `/areas`. */
  depth: DepthResolution
  electoralArea: ElectoralArea | null
  areaStatus: 'idle' | 'loading' | 'ready' | 'missing' | 'error'
  office: OfficeKey | null
  contest: Contest | null
  /** Per-state office in the national view: no single contest, cross map by office. */
  national: boolean
  candidate: Candidate | null
  candidateId: string | null
  mapRequest: MapRequest | null
  resultsRequest: { contestId: string; areaId: string } | null
  /** First page of the result for `resultsRequest`; further pages go through `useResults`. */
  results: ApiQuery<AreaResult>
  loading: boolean
  error: ApiClientError | null
  warnings: string[]
  retry: () => void
}

const STATE_CODE = /^\d{2}$/
const MUNICIPALITY_CODE = /^\d{7}$/
const INVALID_AREA_CODES = new Set(['AREA_NOT_FOUND', 'INCOMPATIBLE_AREA', 'INVALID_PARAMETERS'])

/**
 * Composes URL state, session, electoral area, contest and slots for the Brazil view. Inert
 * without the elections collection: no request leaves the page.
 */
export function useElection(input: {
  countryCode: CountryCode
  selectionId: string | null
}): ElectionSnapshot {
  const state = useElectionLocation()
  const active = input.countryCode === 'BR' && state.collection === 'elections'
  const session = useElectionSession(
    active ? { round: state.round, publication: state.publication } : null,
  )
  const ready = session.status === 'ready' ? session : null
  const contestsQuery = useContests(active)
  const contests = active ? (contestsQuery.data?.items ?? null) : null

  const featureId =
    active &&
    !state.area &&
    input.selectionId &&
    (STATE_CODE.test(input.selectionId) || MUNICIPALITY_CODE.test(input.selectionId))
      ? input.selectionId
      : null
  const areaQuery = useElectoralArea(featureId)
  // `area` (exterior, locality, region) only has results for president; otherwise it is ignored.
  const areaParameter = active && state.area && areaAllowed(state.office) ? state.area : null
  const areaIgnored = active && !!state.area && !areaParameter
  const baseAreaId = !active
    ? null
    : (areaParameter ?? (featureId ? (areaQuery.area?.id ?? null) : 'br'))
  const areaId = baseAreaId ? specificAreaId(baseAreaId, state.zone, state.section) : null
  const depth = useDepth(state.zone ? baseAreaId : null, state.zone, state.section)
  const depthReady = !state.zone || depth.status === 'ready'

  const office = active ? state.office : null
  const contest = office && areaId && contests ? deriveContest(contests, office, areaId) : null
  const national = !!(
    office &&
    areaId &&
    contests &&
    !contest &&
    isNationalOffice(contests, office, areaId)
  )
  const offices = contests && areaId ? availableOffices(contests, areaId) : []

  const candidateQuery = useCandidate(contest?.id ?? null, active ? state.candidate : null)
  const candidate = candidateQuery.candidate
  const candidatePending = !!contest && !!state.candidate && candidateQuery.status === 'loading'
  const mapRequest =
    office && areaId && (contest || national)
      ? deriveMapRequest({
          office,
          contest,
          national,
          level: state.level,
          metric: state.metric,
          candidateId: candidate?.id ?? null,
          candidatePending,
          areaId,
        })
      : null
  const resultsRequest =
    contest && areaId && depthReady && !depth.missing ? { contestId: contest.id, areaId } : null
  const results = useResults(resultsRequest?.contestId ?? null, resultsRequest?.areaId ?? null)

  // An unknown zone, section or `area` (400/404 on /results) is cleared from the URL with a
  // notice that stays while the fallback area is shown.
  const [notice, setNotice] = useState<{ areaId: string; message: string } | null>(null)
  const invalidArea =
    results.status === 'error' &&
    results.error !== null &&
    INVALID_AREA_CODES.has(results.error.code)
  const { area, zone, section } = state
  useEffect(() => {
    if (!invalidArea) return
    if (area) {
      setNotice({
        areaId: 'br',
        message: `A área ${area} não existe nesta publicação; voltando ao Brasil.`,
      })
      navigateElection({ area: null }, true)
    } else if (zone && baseAreaId) {
      setNotice({
        areaId: baseAreaId,
        message: `A zona ${zone}${section ? ` e a seção ${section}` : ''} não existem nesta publicação; mostrando o município.`,
      })
      navigateElection({ zone: null, section: null }, true)
    }
  }, [invalidArea, area, zone, section, baseAreaId])
  useEffect(() => {
    if (!active) setNotice(null)
  }, [active])
  // Zone or section codes absent below their parent; `area` with another office or none.
  const { missing } = depth
  useEffect(() => {
    if (areaIgnored) {
      setNotice({ areaId: 'br', message: `${AREA_OFFICE_NOTICE} Área ignorada.` })
      navigateElection({ area: null }, true)
    } else if (missing === 'zone' && zone && baseAreaId) {
      setNotice({
        areaId: baseAreaId,
        message: zoneNotFound(zone, areaKind(baseAreaId) ?? 'municipality'),
      })
      navigateElection({ zone: null, section: null }, true)
    } else if (missing === 'section' && zone && section && baseAreaId) {
      setNotice({
        areaId: specificAreaId(baseAreaId, zone, null),
        message: sectionNotFound(section, zone),
      })
      navigateElection({ section: null }, true)
    }
  }, [areaIgnored, missing, zone, section, baseAreaId])

  const warnings = [...state.warnings]
  if (notice && notice.areaId === areaId) warnings.push(notice.message)
  if (session.status === 'empty') warnings.push(session.message)
  if (ready?.warning) warnings.push(ready.warning)
  if (areaQuery.status === 'missing')
    warnings.push('Esta localidade não tem área eleitoral nesta publicação.')
  if (office && areaId && contests && !contest && !national)
    warnings.push(`Sem disputa de ${OFFICE_NAMES[office]} para esta área; cargo ignorado.`)
  if (contest && state.candidate && candidateQuery.status === 'missing')
    warnings.push(`A candidatura ${state.candidate} não existe nesta disputa; foco ignorado.`)

  const error =
    (session.status === 'error' ? session.error : null) ??
    contestsQuery.error ??
    areaQuery.error ??
    depth.error ??
    candidateQuery.error
  const loading =
    session.status === 'loading' ||
    contestsQuery.status === 'loading' ||
    areaQuery.status === 'loading' ||
    depth.status === 'loading' ||
    candidateQuery.status === 'loading'

  return {
    active,
    state,
    session,
    edition: ready?.edition ?? null,
    publicationId: ready?.publicationId ?? null,
    coverage: ready?.coverage ?? null,
    contests,
    offices,
    baseAreaId,
    areaId,
    areaKind: areaKind(areaParameter),
    depth,
    electoralArea: areaQuery.area,
    areaStatus: areaQuery.status,
    office,
    contest,
    national,
    candidate,
    candidateId: candidate?.id ?? null,
    mapRequest,
    resultsRequest,
    results,
    loading,
    error,
    warnings,
    retry: () => {
      if (session.status === 'error') retrySession()
      if (contestsQuery.status === 'error') contestsQuery.retry()
      if (areaQuery.status === 'error') areaQuery.retry()
      if (depth.status === 'error') depth.retry()
      if (candidateQuery.status === 'error') candidateQuery.retry()
    },
  }
}
