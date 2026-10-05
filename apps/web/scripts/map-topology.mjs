import { geoAlbersUsa, geoMercator, geoPath } from 'd3-geo'
import { merge, mergeArcs } from 'topojson-client'
import { topology } from 'topojson-server'

// Derive every boundary from the same municipal arcs; independent simplification creates gaps.
export function buildMap({ countryCode = 'BR', year, source, sources, states, regions }) {
  const map = topology({ regions: { type: 'FeatureCollection', features: regions } })
  map.objects.states = {
    type: 'GeometryCollection',
    geometries: states.map(({ properties }) => ({
      ...mergeArcs(
        map,
        map.objects.regions.geometries.filter(
          (area) => area.properties.stateCode === properties.stateCode,
        ),
      ),
      properties,
    })),
  }
  return { countryCode, year, source, sources, ...map }
}

export function mapOutline(map) {
  const country = merge(map, map.objects.states.geometries)
  const projection = map.countryCode === 'US' ? geoAlbersUsa() : geoMercator()
  const path = geoPath(projection.fitSize([1000, 1000], country)).digits(0)
  const [[x0, y0], [x1, y1]] = path.bounds(country)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}"><path d="${path(country)}"/></svg>`
}
