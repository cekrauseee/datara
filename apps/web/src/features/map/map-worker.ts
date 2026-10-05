import { geoPath, type GeoPermissibleObjects } from 'd3-geo'

import { countries, type CountryCode } from './map-countries'
import {
  readDetails,
  readMap,
  readSearchIndex,
  type MapFeature,
  type MapViewData,
} from './map-data'
import { createProjection } from './map-geometry'
import { cached, fetchJSON } from './map-requests'
import type {
  MapWorkerRequest,
  SerializedDetails,
  SerializedPath,
  SerializedScene,
} from './map-worker-types'

function countryData(code: CountryCode) {
  const path = countries[code].map
  return cached(path, async () => {
    const data = readMap(await fetchJSON(path))
    if (data.countryCode !== code) throw new Error('Wrong country')
    return data
  })
}
function detailData(code: string) {
  if (!/^[0-9]{2}$/.test(code)) throw new Error('Invalid state code')
  const path = `maps/us/2025/details/${code}.json`
  return cached(path, async () => readDetails(await fetchJSON(path), code))
}
function paths(projection: ReturnType<typeof createProjection>) {
  // SVG path strings cross the worker boundary without cloning hundreds of thousands of coordinate arrays.
  const path = geoPath(projection).digits(6)
  const project = (geometry: GeoPermissibleObjects): SerializedPath => ({
    svg: path(geometry) ?? '',
    bounds: path.bounds(geometry),
  })
  return {
    project,
    shape: (feature: MapFeature) => ({ area: feature.properties, ...project(feature) }),
  }
}

async function projectItems<T, R>(items: T[], convert: (item: T) => R, signal: AbortSignal) {
  const result: R[] = []
  let start = performance.now()
  for (const item of items) {
    signal.throwIfAborted()
    result.push(convert(item))
    if (performance.now() - start >= 8) {
      // Let newer viewport requests cancel obsolete work, even while a large state is preparing.
      await new Promise((resolve) => setTimeout(resolve, 0))
      start = performance.now()
    }
  }
  return result
}

async function run(request: MapWorkerRequest, signal: AbortSignal) {
  switch (request.kind) {
    case 'map': {
      const data = await countryData(request.countryCode)
      return {
        countryCode: data.countryCode,
        year: data.year,
        source: data.source,
        states: data.states.map(({ properties }) => ({ properties })),
        regions: data.regions.map(({ properties }) => ({ properties })),
      } satisfies MapViewData
    }
    case 'scene': {
      const data = await countryData(request.countryCode)
      signal.throwIfAborted()
      const { width, height } = request
      const projection = createProjection(request.countryCode).fitExtent(
        [
          [width * 0.07, height * 0.1],
          [width * 0.93, height * 0.9],
        ],
        { type: 'FeatureCollection', features: data.states },
      )
      const { project, shape } = paths(projection)
      return {
        projection: {
          countryCode: request.countryCode,
          scale: projection.scale(),
          translate: projection.translate(),
        },
        states: await projectItems(data.states, shape, signal),
        regions: await projectItems(data.regions, shape, signal),
        regionBorders: await projectItems(data.regionBorders, project, signal),
        stateBorders: project(data.stateBorders),
      } satisfies SerializedScene
    }
    case 'details-ready':
      await detailData(request.stateCode)
      return request.stateCode
    case 'feature': {
      const data = await detailData(request.stateCode)
      const feature = [...data.places, ...data.subdivisions].find(
        (f) => f.properties.id === request.id,
      )
      if (!feature) throw new Error('Locality not found')
      return feature
    }
    case 'details': {
      const data = await detailData(request.stateCode)
      const projection = createProjection(request.projection.countryCode)
        .scale(request.projection.scale)
        .translate(request.projection.translate)
      const { project, shape } = paths(projection)
      return {
        places: await projectItems(data.places, shape, signal),
        subdivisions: await projectItems(data.subdivisions, shape, signal),
        placeBorders: project(data.placeBorders),
        subdivisionBorders: project(data.subdivisionBorders),
      } satisfies SerializedDetails
    }
    case 'search':
      return cached('search', async () =>
        readSearchIndex(await fetchJSON('maps/us/2025/search.json')),
      )
  }
}
const jobs = new Map<number, AbortController>()
self.onmessage = ({
  data,
}: MessageEvent<{ id: number; request: MapWorkerRequest } | { cancel: number }>) => {
  if ('cancel' in data) {
    jobs.get(data.cancel)?.abort()
    return
  }
  const controller = new AbortController()
  jobs.set(data.id, controller)
  void run(data.request, controller.signal)
    .then(
      (value) => {
        if (!controller.signal.aborted) self.postMessage({ id: data.id, value })
      },
      (error) =>
        self.postMessage({
          id: data.id,
          error: error instanceof Error ? error.message : String(error),
        }),
    )
    .finally(() => jobs.delete(data.id))
}
