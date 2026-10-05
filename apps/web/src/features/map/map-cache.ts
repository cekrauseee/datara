import { countries, type CountryCode } from './map-countries'
import type { Area, MapFeature, MapViewData } from './map-data'
import { cached } from './map-requests'
import { mapWorker } from './map-worker-api'

export function loadCountryMap(countryCode: CountryCode) {
  return cached(countries[countryCode].map, () =>
    mapWorker<MapViewData>({ kind: 'map', countryCode }),
  )
}
export function loadSearchIndex() {
  return cached('search', () => mapWorker<Area[]>({ kind: 'search' }))
}
export function loadMapDetails(stateCode: string) {
  return cached(`details:${stateCode}`, () =>
    mapWorker<string>({ kind: 'details-ready', stateCode }),
  )
}
export function loadDetailFeature(stateCode: string, id: string) {
  return cached(`feature:${id}`, () => mapWorker<MapFeature>({ kind: 'feature', stateCode, id }))
}
