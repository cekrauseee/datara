import { useCallback, useEffect, useEffectEvent, useState } from 'react'

import { evict } from './api-cache'
import { toApiClientError, type ApiClientError } from './api-client'

export type ApiQuery<T> = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Request URL, also the cache key; `null` when idle. */
  key: string | null
  /** Data for `key`, only when ready. */
  data: T | null
  /** Last data of a previous key, while the current one loads or fails. */
  previous: T | null
  error: ApiClientError | null
  retry: () => void
}

type Settled<T> = { key: string; attempt: number; data: T | null; error: ApiClientError | null }

/**
 * One request slot keyed by URL. Each key change aborts the staleness guard of the previous run,
 * so a late response never overwrites a newer key; `retry` evicts the cache entry and reloads.
 */
export function useApiQuery<T>(key: string | null, load: (url: string) => Promise<T>): ApiQuery<T> {
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState<Settled<T> | null>(null)
  const run = useEffectEvent(load)

  useEffect(() => {
    if (key === null) return
    const controller = new AbortController()
    run(key).then(
      (data) => {
        if (!controller.signal.aborted) setSettled({ key, attempt, data, error: null })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        const failure = toApiClientError(error)
        // The session re-pinned the publication; the key is about to change.
        if (failure.code === 'SUPERSEDED') return
        setSettled({ key, attempt, data: null, error: failure })
      },
    )
    return () => controller.abort()
  }, [key, attempt])

  const retry = useCallback(() => {
    if (key !== null) evict(key)
    setAttempt((value) => value + 1)
  }, [key])

  const current = settled && settled.key === key && settled.attempt === attempt ? settled : null
  const previous = settled && settled.key !== key ? settled.data : null
  if (key === null) return { status: 'idle', key, data: null, previous, error: null, retry }
  if (!current) return { status: 'loading', key, data: null, previous, error: null, retry }
  if (current.error)
    return { status: 'error', key, data: null, previous, error: current.error, retry }
  return { status: 'ready', key, data: current.data, previous: null, error: null, retry }
}
