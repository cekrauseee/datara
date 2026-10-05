// Shared by country views; a reload clears this cache. Failed requests can be retried.
const cache = new Map<string, Promise<unknown>>()

export function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const existing = cache.get(key)
  if (existing) return existing as Promise<T>
  const request = load().catch((error) => {
    cache.delete(key)
    throw error
  })
  cache.set(key, request)
  return request
}

export async function fetchJSON(path: string) {
  const response = await fetch(`${import.meta.env.BASE_URL}${path}`, {
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`Map download failed: ${response.status}`)
  return response.json()
}
