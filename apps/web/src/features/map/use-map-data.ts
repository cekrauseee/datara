import { useCallback, useEffect, useRef, useState } from 'react'

import { loadCountryMap, loadMapDetails, loadSearchIndex } from './map-cache'
import type { CountryCode } from './map-countries'
import type { Area, MapViewData } from './map-data'

export function useMapData(countryCode: CountryCode) {
  const [data, setData] = useState<MapViewData | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [localAreas, setLocalAreas] = useState<Area[]>([])
  const [searchStatus, setSearchStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detailErrors, setDetailErrors] = useState<string[]>([])
  const [loadingDetails, setLoadingDetails] = useState(0)
  const controller = useRef<AbortController | null>(null)
  const pending = useRef(new Map<string, Promise<string>>())

  useEffect(() => {
    const abort = new AbortController()
    controller.current = abort
    pending.current.clear()
    setError('')
    setData(null)
    setLocalAreas([])
    setDetailErrors([])
    setLoadingDetails(0)
    setSearchStatus('loading')
    loadCountryMap(countryCode)
      .then(async (map) => {
        if (abort.signal.aborted) return
        if (map.countryCode !== countryCode) throw new Error('Wrong country')
        setData(map)
        if (countryCode === 'US') {
          try {
            const index = await loadSearchIndex()
            if (!abort.signal.aborted) setLocalAreas(index)
          } catch {
            if (!abort.signal.aborted) setSearchStatus('error')
            return
          }
        }
        if (!abort.signal.aborted) setSearchStatus('ready')
      })
      .catch(() => {
        if (!abort.signal.aborted) setError('Não foi possível carregar o mapa. Tente novamente.')
      })
    return () => abort.abort()
  }, [countryCode, attempt])

  const loadDetails = useCallback((stateCode: string) => {
    const existing = pending.current.get(stateCode)
    if (existing) return existing
    const signal = controller.current!.signal
    setLoadingDetails((count) => count + 1)
    const request = loadMapDetails(stateCode)
      .then((detail) => {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        setDetailErrors((current) => current.filter((code) => code !== stateCode))
        return detail
      })
      .catch((error) => {
        // Keep failed requests until an explicit retry, instead of retrying on every frame.
        if (!signal.aborted)
          setDetailErrors((current) =>
            current.includes(stateCode) ? current : [...current, stateCode],
          )
        throw error
      })
      .finally(() => {
        if (!signal.aborted) setLoadingDetails((count) => count - 1)
      })
    pending.current.set(stateCode, request)
    return request
  }, [])

  function retryDetails() {
    for (const code of detailErrors) pending.current.delete(code)
    setDetailErrors([])
    return detailErrors
  }

  return {
    data,
    error,
    localAreas,
    searchStatus,
    detailError: detailErrors.length > 0,
    loadingDetails,
    loadDetails,
    retryDetails,
    retry: () => setAttempt((value) => value + 1),
  }
}
