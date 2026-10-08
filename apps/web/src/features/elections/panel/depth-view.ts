import type { Area } from '../../map/map-data'
import { regionName } from '../depth'
import type { ElectionPatch } from '../election-location'
import { titleCase } from '../format'
import type { ElectionSnapshot } from '../use-election'

// Titles, scope lines and breadcrumb items of the levels below the mesh: zone, section, exterior,
// exterior locality and region. The mesh levels (country, state, municipality) stay with the
// explorer and the panel.

export type DepthView = {
  /** Panel title, e.g. "Zona 0004 · Zona eleitoral". */
  title: string
  /** Short name for messages and the sheet summary, e.g. "Zona 0004". */
  name: string
  /** Scope line under the subtitle, e.g. "Porto Walter, AC". */
  scope: string | null
  level: 'zone' | 'section' | 'exterior' | 'locality' | 'region'
}

/** Name of the `area` parameter's area: from the loaded result, the fixed names otherwise. */
export function depthAreaName(election: ElectionSnapshot): string | null {
  const id = election.state.area
  if (!id || !election.areaKind) return null
  if (election.areaKind === 'exterior') return 'Exterior'
  if (election.areaKind === 'region') return regionName(id)
  const result = election.results.data ?? election.results.previous
  const area =
    result?.area.id === id
      ? result.area
      : election.depth.locality?.id === id
        ? election.depth.locality
        : null
  return area ? titleCase(area.name) : null
}

/** View of the level below the mesh, or `null` at country, state and municipality. */
export function depthView(election: ElectionSnapshot, selection: Area | null): DepthView | null {
  if (!election.active) return null
  const { zone, section } = election.state
  const kind = election.areaKind
  const parent =
    kind === 'locality'
      ? `${depthAreaName(election) ?? election.state.area}, Exterior`
      : selection
        ? `${selection.name}, ${selection.stateAbbr}`
        : null
  if (zone && section)
    return {
      title: `Seção ${section} · Seção eleitoral`,
      name: `Seção ${section}`,
      scope: `Zona ${zone}${parent ? ` · ${parent}` : ''}`,
      level: 'section',
    }
  if (zone)
    return {
      title: `Zona ${zone} · Zona eleitoral`,
      name: `Zona ${zone}`,
      scope: parent,
      level: 'zone',
    }
  if (kind === 'exterior')
    return { title: 'Exterior', name: 'Exterior', scope: 'Seções no exterior', level: 'exterior' }
  if (kind === 'locality') {
    const name = depthAreaName(election) ?? election.state.area ?? ''
    return { title: `${name} · Localidade no exterior`, name, scope: 'Exterior', level: 'locality' }
  }
  if (kind === 'region') {
    const name = depthAreaName(election) ?? ''
    return { title: `${name} · Região`, name, scope: 'Soma das UFs da região', level: 'region' }
  }
  return null
}

export type DepthCrumb = { key: string; label: string; patch: ElectionPatch | null }

/**
 * Breadcrumb items after the mesh items (country, state, municipality): zone and section after a
 * municipality; exterior, locality, zone and section or the region after the country. Ancestors
 * carry the URL patch that returns to them; the last item has none.
 */
export function depthCrumbs(election: ElectionSnapshot): DepthCrumb[] {
  if (!election.active) return []
  const crumbs: DepthCrumb[] = []
  const kind = election.areaKind
  if (kind === 'region')
    crumbs.push({ key: 'region', label: depthAreaName(election) ?? '', patch: null })
  if (kind === 'exterior' || kind === 'locality')
    crumbs.push({ key: 'exterior', label: 'Exterior', patch: { area: 'exterior' } })
  if (kind === 'locality')
    crumbs.push({
      key: 'locality',
      label: depthAreaName(election) ?? election.state.area ?? '',
      patch: { area: election.state.area, zone: null, section: null },
    })
  const { zone, section } = election.state
  if (zone) crumbs.push({ key: 'zone', label: `Zona ${zone}`, patch: { zone, section: null } })
  if (section) crumbs.push({ key: 'section', label: `Seção ${section}`, patch: null })
  if (crumbs.length > 0) crumbs[crumbs.length - 1].patch = null
  return crumbs
}
