import { useEffect, useSyncExternalStore } from 'react'

import type { CountryCode } from './map-countries'
import type { Area } from './map-data'
import { locationURL, readLocation } from './map-location'

function subscribe(callback: () => void) {
  window.addEventListener('popstate', callback)
  window.addEventListener('map:navigate', callback)
  return () => {
    window.removeEventListener('popstate', callback)
    window.removeEventListener('map:navigate', callback)
  }
}
const snapshot = () => window.location.href
const countryLocations = new Map<CountryCode, string>()

function commitLocation(next: string, replace = false) {
  if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return
  window.history[replace ? 'replaceState' : 'pushState'](null, '', next)
  window.dispatchEvent(new Event('map:navigate'))
}

export function navigateMap(countryCode: CountryCode, area: Area | null, replace = false) {
  commitLocation(
    locationURL(new URL(window.location.href), countryCode, area, import.meta.env.BASE_URL),
    replace,
  )
}

export function navigateCountry(countryCode: CountryCode) {
  commitLocation(
    countryLocations.get(countryCode) ??
      locationURL(new URL(window.location.href), countryCode, null, import.meta.env.BASE_URL),
  )
}

export function useMapLocation() {
  const href = useSyncExternalStore(subscribe, snapshot)
  const location = readLocation(new URL(href), import.meta.env.BASE_URL)
  useEffect(() => {
    const url = new URL(href)
    const path = `${import.meta.env.BASE_URL}${location.countryCode.toLowerCase()}`
    countryLocations.set(location.countryCode, `${path}${url.search}${url.hash}`)
    if (url.pathname === path) return
    url.pathname = path
    window.history.replaceState(null, '', url)
    window.dispatchEvent(new Event('map:navigate'))
  }, [href, location.countryCode])
  return location
}
