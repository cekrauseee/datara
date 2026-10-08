// Single integration point for the election modules (map layer, panel, candidate focus, lists).
export { cached, clear, evict } from './api-cache'
export {
  API_URL,
  ApiClientError,
  apiFetch,
  apiRequest,
  apiURL,
  isApiError,
  photoURL,
} from './api-client'
export type { ApiParams } from './api-client'
export type * from './api-types'
export { ElectionControls } from './election-controls'
export {
  CANDIDATE_METRICS,
  COLLECTIONS,
  ELECTION_PARAMETERS,
  LEVELS,
  METRICS,
  OFFICES,
  OFFICE_CODES,
  OFFICE_SCOPES,
  clearElectionParameters,
  defaultMetric,
  electionURL,
  isMetric,
  isOffice,
  readElection,
  withoutElectionParameters,
  writeElection,
} from './election-location'
export type {
  Collection,
  ElectionParameter,
  ElectionPatch,
  ElectionState,
  Level,
  Metric,
  OfficeKey,
} from './election-location'
export {
  API_METRICS,
  EDITION,
  MAJORITARIAN_OFFICES,
  OFFICE_BY_CODE,
  OFFICE_NAMES,
  availableOffices,
  contestCovers,
  deriveContest,
  deriveMapRequest,
  indexContests,
  isNationalOffice,
  specificAreaId,
} from './election-model'
export type {
  ContestIndex,
  ContestMapRequest,
  MapRequest,
  OfficeAvailability,
  OfficeMapRequest,
} from './election-model'
export {
  ensureSession,
  getSession,
  retrySession,
  subscribeSession,
  useElectionSession,
  useSession,
} from './election-session'
export type { SessionInput, SessionState } from './election-session'
export { ElectionStatus } from './election-status'
export { classifyMap, isCrossMap, legendCounts, metricBands } from './map-classes'
export type {
  ClassifiedMap,
  FillMeta,
  LegendModel,
  LegendRow,
  MapData,
  MapDataItem,
} from './map-classes'
export { formatCount, formatPercent, formatPoints, formatVotes } from './map-format'
export { MapHoverDetail, hoverTarget } from './map-hover-detail'
export type { HoverTarget } from './map-hover-detail'
export { MapLegend } from './map-legend'
export { useApiQuery } from './use-api-query'
export type { ApiQuery } from './use-api-query'
export { useElection } from './use-election'
export type { ElectionSnapshot } from './use-election'
export {
  useAreas,
  useCandidate,
  useCandidates,
  useContestMap,
  useContests,
  useDistribution,
  useElectionMap,
  useElectoralArea,
  useOfficeMap,
  useResults,
} from './use-election-data'
export type { CandidateQuery, ElectoralAreaQuery, Page } from './use-election-data'
export { navigateElection, useElectionLocation } from './use-election-location'
export { useMapLayer } from './use-map-layer'
export type { MapLayerState } from './use-map-layer'
