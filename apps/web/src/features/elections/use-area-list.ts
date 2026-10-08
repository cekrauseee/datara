import { useState } from 'react'

import type { ApiClientError } from './api-client'
import type { AreaLevel, AreaList, ElectoralArea } from './api-types'
import { findByCode, principalCode } from './depth'
import type { ApiQuery } from './use-api-query'
import { useAreaSearch, useAreas } from './use-election-data'

/** Page size of every navigation list below the municipality (zones, sections, localities). */
export const AREA_PAGE = 100

/** One page of a navigation list, in API order, with the pinned publication. */
export function useAreaPage(
  parentId: string | null,
  level: AreaLevel | null,
  offset: number,
): ApiQuery<AreaList> {
  return useAreas(parentId, level, { limit: AREA_PAGE, offset })
}

export type DepthResolution = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  zone: ElectoralArea | null
  section: ElectoralArea | null
  /** Exterior locality of the zone, for its name below the locality level. */
  locality: ElectoralArea | null
  /** The URL value that does not exist below its parent. */
  missing: 'zone' | 'section' | null
  error: ApiClientError | null
  retry: () => void
}

const NOT_FOUND = new Set(['AREA_NOT_FOUND', 'INCOMPATIBLE_AREA'])

/**
 * Resolves the URL `zone` and `section` without composing IDs: the zone among the children of
 * the municipality (or exterior locality) by `q`, matched on `zoneCode`; the section among the
 * children of that zone, matched on `sectionCode`.
 */
export function useDepth(
  baseAreaId: string | null,
  zone: string | null,
  section: string | null,
): DepthResolution {
  const zoneQuery = useAreas(baseAreaId && zone ? baseAreaId : null, 'zone', {}, { q: zone ?? '' })
  const zoneItem = zone && zoneQuery.data ? findByCode(zoneQuery.data.items, 'zone', zone) : null
  const sectionQuery = useAreas(
    zoneItem && section ? zoneItem.id : null,
    'section',
    {},
    { q: section ?? '' },
  )
  const sectionItem =
    section && sectionQuery.data ? findByCode(sectionQuery.data.items, 'section', section) : null
  const localityQuery = useAreaSearch(
    zoneItem?.uf === 'zz' && zoneItem.municipalityCode
      ? { level: 'municipality', uf: 'zz', municipalityCode: zoneItem.municipalityCode }
      : null,
  )
  const locality = localityQuery.data?.items[0] ?? null
  const idle = { zone: null, section: null, locality, missing: null, error: null }
  const retry = () => {
    if (zoneQuery.status === 'error') zoneQuery.retry()
    if (sectionQuery.status === 'error') sectionQuery.retry()
  }
  if (!baseAreaId || !zone) return { status: 'idle', ...idle, retry }
  if (zoneQuery.status === 'error' && zoneQuery.error) {
    if (NOT_FOUND.has(zoneQuery.error.code))
      return { status: 'ready', ...idle, missing: 'zone', retry }
    return { status: 'error', ...idle, error: zoneQuery.error, retry }
  }
  if (zoneQuery.status !== 'ready') return { status: 'loading', ...idle, retry }
  if (!zoneItem) return { status: 'ready', ...idle, missing: 'zone', retry }
  if (!section) return { status: 'ready', ...idle, zone: zoneItem, retry }
  if (sectionQuery.status === 'error' && sectionQuery.error)
    return { status: 'error', ...idle, zone: zoneItem, error: sectionQuery.error, retry }
  if (sectionQuery.status !== 'ready') return { status: 'loading', ...idle, zone: zoneItem, retry }
  if (!sectionItem) return { status: 'ready', ...idle, zone: zoneItem, missing: 'section', retry }
  return { status: 'ready', ...idle, zone: zoneItem, section: sectionItem, retry }
}

/**
 * Section code of the principal of an aggregated section: walks the pages of the zone's section
 * list (the same cached pages the list uses) until the item whose `id` is the principal appears.
 * Mount with a key per principal so the walk restarts.
 */
export function usePrincipalCode(
  zoneId: string | null,
  principalAreaId: string | null,
): { code: string | null; status: 'idle' | 'loading' | 'ready' | 'missing' | 'error' } {
  const [offset, setOffset] = useState(0)
  const query = useAreaPage(zoneId && principalAreaId ? zoneId : null, 'section', offset)
  if (!zoneId || !principalAreaId) return { code: null, status: 'idle' }
  if (query.status === 'error') return { code: null, status: 'error' }
  const data = query.data
  if (!data) return { code: null, status: 'loading' }
  const code = principalCode(data.items, principalAreaId)
  if (code) return { code, status: 'ready' }
  if (data.pagination.hasMore && data.pagination.offset === offset) {
    // Render-phase update: React re-renders this component at once with the next page.
    setOffset(offset + AREA_PAGE)
    return { code: null, status: 'loading' }
  }
  return { code: null, status: 'missing' }
}
