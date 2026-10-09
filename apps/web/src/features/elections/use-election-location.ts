import { useEffect, useSyncExternalStore } from 'react'

import { commitLocation, locationSnapshot, subscribeLocation } from '../map/use-map-location'
import {
  electionURL,
  readElection,
  type ElectionPatch,
  type ElectionState,
} from './election-location'

/** Election parameters of the current URL; `area` removes a conflicting IBGE selection. */
export function useElectionLocation(): ElectionState {
  const href = useSyncExternalStore(subscribeLocation, locationSnapshot)
  const url = new URL(href)
  const state = readElection(url, import.meta.env.BASE_URL)
  const overridden =
    state.area !== null && (url.searchParams.has('state') || url.searchParams.has('municipality'))
  useEffect(() => {
    if (!overridden) return
    const next = new URL(href)
    next.searchParams.delete('state')
    next.searchParams.delete('municipality')
    commitLocation(`${next.pathname}${next.search}${next.hash}`, true)
  }, [href, overridden])
  return state
}

/** Writes election parameters; `{ collection: null }` returns to pure geography. */
export function navigateElection(patch: ElectionPatch, replace = false) {
  commitLocation(
    electionURL(new URL(window.location.href), patch, import.meta.env.BASE_URL),
    replace,
  )
}
