// Named views over the generated OpenAPI types. Never edit api-types.generated.ts by hand:
// regenerate it with `pnpm --filter @datara/web api:types` and verify drift with `api:types:check`.
import type { components, paths } from './api-types.generated'

type Schemas = components['schemas']
type Json200<Path extends keyof paths> = paths[Path] extends {
  get: { responses: { 200: { content: { 'application/json': infer Body } } } }
}
  ? Body
  : never

export type Election = Schemas['Election']
export type Publication = Schemas['Publication']
export type Coverage = Schemas['Coverage']
export type Contest = Schemas['Contest']
export type ElectoralArea = Schemas['ElectoralArea']
export type AreaLevel = ElectoralArea['level']
export type Candidate = Schemas['Candidate']
export type AreaResult = Schemas['AreaResult']
export type ResultTotals = Schemas['ResultTotals']
export type PercentageMeasure = Schemas['PercentageMeasure']
export type Source = Schemas['Source']
export type ApiErrorBody = Schemas['Error']

export type ElectionList = Json200<'/elections'>
export type ContestList = Json200<'/elections/{electionId}/contests'>
export type AreaList = Json200<'/elections/{electionId}/areas'>
export type ElectionMapResponse = Json200<'/elections/{electionId}/map'>
export type CandidateList = Json200<'/contests/{contestId}/candidates'>
export type DistributionResponse = Json200<'/contests/{contestId}/distribution'>
export type MapResponse = Json200<'/contests/{contestId}/map'>

export type MapLevel = MapResponse['level']
export type MapMetric = MapResponse['metric']
export type OfficeMapMetric = ElectionMapResponse['metric']
export type MapItem = MapResponse['items'][number]
export type OfficeMapItem = ElectionMapResponse['items'][number]
export type MapCandidate = MapResponse['candidates'][string]
export type DistributionLevel = NonNullable<
  paths['/contests/{contestId}/distribution']['get']['parameters']['query']
>['level']
export type DistributionSort = NonNullable<
  paths['/contests/{contestId}/distribution']['get']['parameters']['query']
>['sort']
