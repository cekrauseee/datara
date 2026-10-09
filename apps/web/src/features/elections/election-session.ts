import { useEffect, useSyncExternalStore } from 'react'

import { clear } from './api-cache'
import { apiFetch, isApiError, toApiClientError, type ApiClientError } from './api-client'
import type { Coverage, Election, ElectionList } from './api-types'
import { EDITION } from './election-model'

// Publication pinned per session: resolved once per round (and URL publication) so every later
// request carries the same publicationId. A national load published mid-session shows up only
// after a reload, unless the pinned publication disappears (see repinAfterNotFound).

export type SessionInput = { round: 1 | 2; publication: string | null }
export type SessionState =
  | { status: 'idle' }
  | { status: 'loading'; input: SessionInput }
  | { status: 'empty'; input: SessionInput; message: string }
  | { status: 'error'; input: SessionInput; error: ApiClientError }
  | {
      status: 'ready'
      input: SessionInput
      edition: Election
      /** Active publication at bootstrap. */
      pinned: string
      /** Effective publication: the URL's when it exists, otherwise the pinned one. */
      publicationId: string
      coverage: Coverage
      warning: string | null
    }

let session: SessionState = { status: 'idle' }
const listeners = new Set<() => void>()
let inflight: { key: string; promise: Promise<void> } | null = null
const repinned = new Set<string>()

function emit(next: SessionState) {
  session = next
  for (const listener of listeners) listener()
}

export function subscribeSession(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const getSession = () => session
const keyOf = (input: SessionInput) => `${input.round}:${input.publication ?? ''}`

async function resolve(input: SessionInput): Promise<SessionState> {
  try {
    const list = await apiFetch<ElectionList>('/elections', {
      country: EDITION.country,
      year: EDITION.year,
      round: input.round,
    })
    const edition = list.items[0]
    if (!edition)
      return {
        status: 'empty',
        input,
        message: `Não há edição publicada para o ${input.round}º turno de ${EDITION.year}.`,
      }
    if (!edition.publication)
      return { status: 'empty', input, message: `A edição ${edition.id} não tem publicação ativa.` }
    const pinned = edition.publication.id
    let publicationId = pinned
    let coverage = edition.publication.coverage
    let warning: string | null = null
    if (input.publication && input.publication.toLowerCase() !== pinned.toLowerCase()) {
      try {
        const explicit = await apiFetch<Election>(`/elections/${edition.id}`, {
          publicationId: input.publication,
        })
        if (explicit.publication) {
          publicationId = explicit.publication.id
          coverage = explicit.publication.coverage
        }
      } catch (error) {
        if (!isApiError(error, 404)) throw error
        warning = `A publicação ${input.publication} não existe; exibindo a publicação ativa.`
      }
    }
    return { status: 'ready', input, edition, pinned, publicationId, coverage, warning }
  } catch (error) {
    return { status: 'error', input, error: toApiClientError(error) }
  }
}

export function ensureSession(input: SessionInput, force = false): Promise<void> {
  const key = keyOf(input)
  if (!force && inflight?.key === key) return inflight.promise
  if (
    !force &&
    session.status !== 'idle' &&
    session.status !== 'error' &&
    keyOf(session.input) === key
  )
    return Promise.resolve()
  emit({ status: 'loading', input })
  const promise = resolve(input).then((next) => {
    if (inflight?.promise !== promise) return
    inflight = null
    emit(next)
  })
  inflight = { key, promise }
  return promise
}

export function retrySession() {
  if ('input' in session) void ensureSession(session.input, true)
}

/**
 * A request with the session pin (not the URL's publication) got 404 PUBLICATION_NOT_FOUND: the
 * active publication changed under us. Clears the cache and re-resolves once per publication;
 * returns whether the pin moved. A second failure stays visible to the user.
 */
export async function repinAfterNotFound(publicationId: string): Promise<boolean> {
  if (
    session.status !== 'ready' ||
    session.publicationId !== publicationId ||
    publicationId !== session.pinned ||
    repinned.has(publicationId)
  )
    return false
  repinned.add(publicationId)
  clear()
  await ensureSession(session.input, true)
  const next = getSession()
  return next.status === 'ready' && next.publicationId !== publicationId
}

/** Current session without triggering resolution. */
export function useSession(): SessionState {
  return useSyncExternalStore(subscribeSession, getSession)
}

/** Current session, resolving it for the given round and URL publication when needed. */
export function useElectionSession(input: SessionInput | null): SessionState {
  const state = useSession()
  const round = input?.round ?? null
  const publication = input?.publication ?? null
  useEffect(() => {
    if (round !== null) void ensureSession({ round, publication })
  }, [round, publication])
  return state
}
