import type { CountryCode } from './map-countries'
import type { Area } from './map-data'
import type { Bounds } from './map-geometry'

export type ProjectionSettings = {
  countryCode: CountryCode
  scale: number
  translate: [number, number]
}
export type SerializedPath = { svg: string; bounds: Bounds }
export type SerializedShape = SerializedPath & { area: Area }
export type SerializedScene = {
  projection: ProjectionSettings
  states: SerializedShape[]
  regions: SerializedShape[]
  regionBorders: SerializedPath[]
  stateBorders: SerializedPath
}
export type SerializedDetails = {
  places: SerializedShape[]
  subdivisions: SerializedShape[]
  placeBorders: SerializedPath
  subdivisionBorders: SerializedPath
}
export type MapWorkerRequest =
  | { kind: 'map'; countryCode: CountryCode }
  | { kind: 'scene'; countryCode: CountryCode; width: number; height: number }
  | { kind: 'details-ready'; stateCode: string }
  | { kind: 'details'; stateCode: string; projection: ProjectionSettings }
  | { kind: 'feature'; stateCode: string; id: string }
  | { kind: 'search' }
