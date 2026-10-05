import { geoAlbersUsa, geoMercator } from 'd3-geo'

import type { CountryCode } from './map-countries'

export function createProjection(countryCode: CountryCode) {
  return countryCode === 'US' ? geoAlbersUsa() : geoMercator()
}

export type Bounds = [[number, number], [number, number]]
export const MAX_ZOOM = 100

export function detailLevel(scale: number) {
  return scale >= 2.5 ? 'regions' : 'states'
}

export function fitBounds(bounds: Bounds, width: number, height: number) {
  const [[x0, y0], [x1, y1]] = bounds
  const k = Math.max(1, Math.min(MAX_ZOOM, 0.78 / Math.max((x1 - x0) / width, (y1 - y0) / height)))
  return { k, x: width / 2 - (k * (x0 + x1)) / 2, y: height / 2 - (k * (y0 + y1)) / 2 }
}

export function intersects(bounds: Bounds, viewport: Bounds) {
  return (
    bounds[0][0] <= viewport[1][0] &&
    bounds[1][0] >= viewport[0][0] &&
    bounds[0][1] <= viewport[1][1] &&
    bounds[1][1] >= viewport[0][1]
  )
}

export function tooltipPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  tooltipWidth: number,
  tooltipHeight: number,
) {
  return {
    left: Math.max(12, Math.min(x + 16, width - tooltipWidth - 12)),
    top: Math.max(12, Math.min(y - tooltipHeight - 12, height - tooltipHeight - 12)),
  }
}
