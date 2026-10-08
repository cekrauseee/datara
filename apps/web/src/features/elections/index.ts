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
export {
  LEVEL_BELOW,
  areaName,
  areaVotes,
  candidateTitle,
  contributionOf,
  formatFocusPercent,
  inArea,
  supportOf,
  toArea,
} from './candidate-focus'
export type { AreaVotes, FocusMeasure } from './candidate-focus'
export { CollectionSelector, OFFICE_SHORT_NAMES } from './collection-selector'
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
export {
  MISSING,
  basisLabel,
  formatDateTime,
  formatInteger,
  formatPercent,
  formatPoints,
  formatVotes,
  initials,
  ratio,
  sourceKindLabel,
  titleCase,
} from './format'
export { classifyMap, isCrossMap, legendCounts, metricBands } from './map-classes'
export type {
  ClassifiedMap,
  FillMeta,
  LegendModel,
  LegendRow,
  MapData,
  MapDataItem,
} from './map-classes'
export { MapHoverDetail, hoverTarget } from './map-hover-detail'
export type { HoverTarget } from './map-hover-detail'
export { MapLegend } from './map-legend'
export { AreaList, ContestAreaList, OfficeAreaList } from './panel/area-list'
export { CandidateCard, exitFocus } from './panel/candidate-card'
export { CandidateDistribution } from './panel/candidate-distribution'
export { MetricToggle } from './panel/metric-toggle'
export {
  byName,
  contestScopeName,
  leaderOf,
  navigationItems,
  panelMode,
  partyLabel,
  scopeName,
  stateName,
} from './panel/panel-model'
export type { NavigationItem, NavigationLeader, PanelMode } from './panel/panel-model'
export { PanelEmpty, PanelError, PanelNotices, PanelSkeleton } from './panel/panel-states'
export { ResultsPanel } from './panel/results-panel'
export type { ResultsPanelProps } from './panel/results-panel'
export { useApiQuery } from './use-api-query'
export type { ApiQuery } from './use-api-query'
export { useCandidateFocus } from './use-candidate-focus'
export type { CandidateFocus } from './use-candidate-focus'
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
export { useMediaQuery } from './use-media-query'
