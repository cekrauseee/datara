import { geoPath, type GeoPermissibleObjects } from 'd3-geo'

import type { MapFeature, MapViewData } from './map-data'
import { createProjection, type Bounds } from './map-geometry'
import { mapWorker } from './map-worker-api'
import type { SerializedDetails, SerializedScene, SerializedShape } from './map-worker-types'

type Projection = ReturnType<typeof createProjection>
export type Shape = { feature: Pick<MapFeature, 'properties'>; path: Path2D; bounds: Bounds }

// Keep only the latest viewport per country; resizing cannot grow the cache indefinitely.
const scenes = new WeakMap<
  MapViewData,
  { width: number; height: number; promise: Promise<MapScene>; controller: AbortController }
>()
let frameDeadline = 0
let scheduledFrame: Promise<void> | undefined
function nextFrame() {
  scheduledFrame ??= new Promise<void>((resolve) =>
    requestAnimationFrame(() => {
      scheduledFrame = undefined
      frameDeadline = performance.now() + 3
      resolve()
    }),
  )
  return scheduledFrame
}

function project(geometry: GeoPermissibleObjects, projection: Projection) {
  const path = new Path2D()
  const bounds: Bounds = [
    [Infinity, Infinity],
    [-Infinity, -Infinity],
  ]
  function include(x: number, y: number) {
    bounds[0][0] = Math.min(bounds[0][0], x)
    bounds[0][1] = Math.min(bounds[0][1], y)
    bounds[1][0] = Math.max(bounds[1][0], x)
    bounds[1][1] = Math.max(bounds[1][1], y)
  }
  // Collect bounds in the same projection pass instead of projecting every vertex twice.
  geoPath(projection, {
    beginPath() {},
    moveTo(x, y) {
      include(x, y)
      path.moveTo(x, y)
    },
    lineTo(x, y) {
      include(x, y)
      path.lineTo(x, y)
    },
    closePath() {
      path.closePath()
    },
    arc(x, y, radius, start, end) {
      include(x - radius, y - radius)
      include(x + radius, y + radius)
      path.arc(x, y, radius, start, end)
    },
  })(geometry)
  return { path, bounds }
}

export function projectFeature(feature: MapFeature, projection: Projection): Shape {
  return { feature, ...project(feature, projection) }
}

async function projectItems<T, R>(items: T[], convert: (item: T) => R, signal?: AbortSignal) {
  const result: R[] = []
  for (const item of items) {
    signal?.throwIfAborted()
    while (performance.now() >= frameDeadline) await nextFrame()
    result.push(convert(item))
  }
  return result
}

type ProjectedDetails = {
  places: Shape[]
  subdivisions: Shape[]
  placeBorders: Path2D
  subdivisionBorders: Path2D
}
export type MapScene = {
  projection: Projection
  states: Shape[]
  regions: Shape[]
  regionBorders: { path: Path2D; bounds: Bounds }[]
  stateBorders: Path2D
  details: Map<string, Promise<ProjectedDetails>>
}

function decodeShape(shape: SerializedShape): Shape {
  return { feature: { properties: shape.area }, path: new Path2D(shape.svg), bounds: shape.bounds }
}

export function prepareScene(data: MapViewData, width: number, height: number): Promise<MapScene> {
  const cached = scenes.get(data)
  if (cached?.width === width && cached.height === height) return cached.promise
  cached?.controller.abort()
  const controller = new AbortController()
  const promise = (async () => {
    const serialized = await mapWorker<SerializedScene>(
      {
        kind: 'scene',
        countryCode: data.countryCode,
        width,
        height,
      },
      controller.signal,
    )
    controller.signal.throwIfAborted()
    const projection = createProjection(data.countryCode)
      .scale(serialized.projection.scale)
      .translate(serialized.projection.translate)
    const states = await projectItems(serialized.states, decodeShape, controller.signal)
    const regions = await projectItems(serialized.regions, decodeShape, controller.signal)
    const regionBorders = await projectItems(
      serialized.regionBorders,
      (border) => ({ path: new Path2D(border.svg), bounds: border.bounds }),
      controller.signal,
    )
    const [stateBorders] = await projectItems(
      [serialized.stateBorders],
      (border) => new Path2D(border.svg),
      controller.signal,
    )
    return {
      projection,
      states,
      regions,
      regionBorders,
      stateBorders,
      details: new Map<string, Promise<ProjectedDetails>>(),
    }
  })().catch((error) => {
    if (scenes.get(data)?.promise === promise) scenes.delete(data)
    throw error
  })
  scenes.set(data, { width, height, promise, controller })
  return promise
}

export function prepareDetails(scene: MapScene, stateCode: string): Promise<ProjectedDetails> {
  const cached = scene.details.get(stateCode)
  if (cached) return cached
  const promise = (async () => {
    const serialized = await mapWorker<SerializedDetails>({
      kind: 'details',
      stateCode,
      projection: {
        countryCode: 'US',
        scale: scene.projection.scale(),
        translate: scene.projection.translate(),
      },
    })
    const places = await projectItems(serialized.places, decodeShape)
    const subdivisions = await projectItems(serialized.subdivisions, decodeShape)
    const [placeBorders, subdivisionBorders] = await projectItems(
      [serialized.placeBorders, serialized.subdivisionBorders],
      (border) => new Path2D(border.svg),
    )
    return { places, subdivisions, placeBorders, subdivisionBorders }
  })().catch((error) => {
    scene.details.delete(stateCode)
    throw error
  })
  scene.details.set(stateCode, promise)
  return promise
}
