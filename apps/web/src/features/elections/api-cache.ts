// In-memory cache keyed by full request URL (which carries publicationId): publications are
// immutable, so entries live for the session. Failures are evicted so a retry can succeed.
const cache = new Map<string, Promise<unknown>>()

export function cached<T>(url: string, load: () => Promise<T>): Promise<T> {
  const existing = cache.get(url)
  if (existing) return existing as Promise<T>
  const request = load().catch((error: unknown) => {
    cache.delete(url)
    throw error
  })
  cache.set(url, request)
  return request
}

export function evict(url: string) {
  cache.delete(url)
}

export function clear() {
  cache.clear()
}

export function cachedKeys() {
  return [...cache.keys()]
}
