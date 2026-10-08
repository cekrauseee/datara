import { useEffect, useSyncExternalStore } from 'react'

import { clearElectionParameters, withoutElectionParameters } from '../elections/election-location'
import type { CountryCode } from './map-countries'
import type { Area } from './map-data'
import { locationURL, readLocation } from './map-location'

export function subscribeLocation(callback: () => void) {
  window.addEventListener('popstate', callback)
  window.addEventListener('map:navigate', callback)
  return () => {
    window.removeEventListener('popstate', callback)
    window.removeEventListener('map:navigate', callback)
  }
}
export const locationSnapshot = () => window.location.href
const countryLocations = new Map<CountryCode, string>()

export function commitLocation(next: string, replace = false) {
  if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return
  window.history[replace ? 'replaceState' : 'pushState'](null, '', next)
  window.dispatchEvent(new Event('map:navigate'))
}

// Geographic navigation keeps the election parameters it does not invalidate.
function mapURL(url: URL, countryCode: CountryCode, area: Area | null) {
  const basePath = import.meta.env.BASE_URL
  const next = new URL(locationURL(url, countryCode, area, basePath), url.origin)
  const previous = readLocation(url, basePath)
  clearElectionParameters(
    next,
    {
      countryCode,
      previousSelectionId: previous.countryCode === 'BR' ? previous.selectionId : null,
    },
    basePath,
  )
  return `${next.pathname}${next.search}${next.hash}`
}

export function navigateMap(countryCode: CountryCode, area: Area | null, replace = false) {
  commitLocation(mapURL(new URL(window.location.href), countryCode, area), replace)
}

export function navigateCountry(countryCode: CountryCode) {
  const retained = countryLocations.get(countryCode)
  commitLocation(
    retained
      ? countryCode === 'BR'
        ? retained
        : withoutElectionParameters(retained)
      : mapURL(new URL(window.location.href), countryCode, null),
  )
}

export function useMapLocation() {
  const href = useSyncExternalStore(subscribeLocation, locationSnapshot)
  const location = readLocation(new URL(href), import.meta.env.BASE_URL)
  useEffect(() => {
    const url = new URL(href)
    const path = `${import.meta.env.BASE_URL}${location.countryCode.toLowerCase()}`
    const target = `${path}${url.search}${url.hash}`
    const canonical = location.countryCode === 'BR' ? target : withoutElectionParameters(target)
    countryLocations.set(location.countryCode, canonical)
    if (`${url.pathname}${url.search}${url.hash}` === canonical) return
    window.history.replaceState(null, '', canonical)
    window.dispatchEvent(new Event('map:navigate'))
  }, [href, location.countryCode])
  return location
}
