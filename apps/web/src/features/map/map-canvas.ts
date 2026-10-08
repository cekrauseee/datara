import { select } from 'd3-selection'
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomTransform } from 'd3-zoom'

import type { Area, MapFeature, MapViewData } from './map-data'
import {
  createProjection,
  detailLevel,
  fitBounds,
  intersects,
  MAX_ZOOM,
  type Bounds,
} from './map-geometry'

import {
  buildLayerGroups,
  hitGrain,
  LAYER_BORDER_ALPHA,
  PARTIAL_VEIL_ALPHA,
  resolveLayerColor,
  type LayerGroups,
  type MapLayer,
} from './map-layer'
import {
  prepareDetails,
  prepareScene,
  projectFeature,
  type MapScene,
  type Shape,
} from './map-projection'
export type MapControls = {
  addDetails: (stateCode: string) => Promise<void>
  fit: (id: string | null, feature?: MapFeature) => void
  scale: (factor: number) => void
  pan: (x: number, y: number) => void
  /** Paints a data layer over the base map, or restores the base with `null`. */
  setLayer: (layer: MapLayer | null) => void
  destroy: () => void
}
export type MapHover = { area: Area; x: number; y: number } | null
export type MapLayerInfo = { key: string; groups: number; fills: number; missing: number } | null

export function createMap(
  canvas: HTMLCanvasElement,
  data: MapViewData,
  callbacks: {
    onError?: (error: unknown) => void
    onDetails?: (states: string[]) => void
    onReady?: () => void
    onSelect: (area: Area) => void
    onHover: (hover: MapHover) => void
    onZoom: (scale: number) => void
    /** After the merged groups of a layer are drawn, or `null` when the base is restored. */
    onLayer?: (info: MapLayerInfo) => void
  },
): MapControls {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Não foi possível desenhar o mapa neste navegador.')
  const ctx = context
  const element = select(canvas)
  const scheme = matchMedia('(prefers-color-scheme: dark)')
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  let projection = createProjection(data.countryCode)
  let scene: MapScene | null = null
  let preparing = true
  let destroyed = false
  let resizeVersion = 0
  let pendingFit = false
  let geometryTask: Promise<void> = Promise.resolve()
  const detailTasks = new Map<string, Promise<void>>()
  let detailView = ''
  let ready = false
  let width = 0
  let height = 0
  let ratio = 1
  let transform = zoomIdentity
  let states: Shape[] = []
  let regions: Shape[] = []
  let regionBorders: { path: Path2D; bounds: Bounds }[] = []
  let stateBorders = new Path2D()
  const details = new Set<string>()
  let places: Shape[] = []
  let subdivisions: Shape[] = []
  const projectedStates = new Set<string>()
  const detailAppearedAt = new Map<string, number>()
  let localBorders: { places: Path2D; subdivisions: Path2D; bounds: Bounds; appearedAt: number }[] =
    []
  let shapes = new Map<string, Shape>()
  let hovered: Shape | undefined
  let selectedId: string | null = null
  let focusFeature: MapFeature | undefined
  let frame = 0
  let hoverFrame = 0
  let animation = 0
  let dragging = false
  let colors: Record<string, string> = {}
  let layer: MapLayer | null = null
  let layerGroups: LayerGroups | null = null
  let layerVersion = 0

  function readColors() {
    const style = getComputedStyle(canvas)
    colors = Object.fromEntries(
      ['background', 'foreground', 'muted', 'muted-foreground', 'primary'].map((token) => [
        token,
        style.getPropertyValue(`--${token}`).trim(),
      ]),
    )
    scheduleDraw()
  }

  function stroke(path: Path2D, color: string, lineWidth: number) {
    ctx.strokeStyle = color
    ctx.lineWidth = lineWidth / transform.k
    ctx.stroke(path)
  }

  function highlight(shape: Shape, alpha: number, lineWidth: number) {
    if (layerGroups) {
      // A fill would tint the data colours: outline only, with a halo for contrast.
      stroke(shape.path, colors.background, lineWidth + 1.6)
      stroke(shape.path, colors.foreground, lineWidth)
      return
    }
    ctx.globalAlpha = alpha
    ctx.fillStyle = colors.primary
    ctx.fill(shape.path)
    ctx.globalAlpha = 1
    stroke(shape.path, colors.foreground, lineWidth)
  }

  function applyLayer(groups: LayerGroups | null) {
    layerGroups = groups
    scheduleDraw()
    callbacks.onLayer?.(
      groups
        ? {
            key: groups.layer.key,
            groups: groups.groups.length,
            fills: groups.fills,
            missing: groups.missing,
          }
        : null,
    )
  }

  function layerShapes(target: MapLayer, current: MapScene) {
    return target.grain === 'municipality' ? current.regions : current.states
  }

  // Rebuilds the merged groups for the current scene; the previous groups stay drawn until the
  // atomic swap, and a newer layer or scene discards the build.
  function rebuildLayer() {
    const version = ++layerVersion
    const target = layer
    const current = scene
    if (!target || !current) {
      if (layerGroups) applyLayer(null)
      return
    }
    if (layerGroups?.layer === target) return
    buildLayerGroups(target, layerShapes(target, current))
      .then((built) => {
        if (destroyed || version !== layerVersion || current !== scene) return
        applyLayer(built)
      })
      .catch((error: unknown) => {
        if (!destroyed && version === layerVersion) callbacks.onError?.(error)
      })
  }

  function draw() {
    frame = 0
    if (!width || !height || preparing) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.translate(transform.x, transform.y)
    ctx.scale(transform.k, transform.k)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    const viewport: Bounds = [transform.invert([0, 0]), transform.invert([width, height])]
    const level = detailLevel(transform.k)
    // Keep the same opaque land surface at every zoom; only add internal boundaries.
    ctx.fillStyle = colors.muted
    for (const shape of states) {
      if (intersects(shape.bounds, viewport)) ctx.fill(shape.path)
    }
    if (layerGroups) {
      for (const group of layerGroups.groups) {
        if (!intersects(group.bounds, viewport)) continue
        ctx.fillStyle = resolveLayerColor(group.color, colors)
        ctx.globalAlpha = group.alpha
        ctx.fill(group.path)
      }
      // Partial results: a muted veil over the class fill equals the class colour at 60 % alpha.
      ctx.fillStyle = colors.muted
      ctx.globalAlpha = PARTIAL_VEIL_ALPHA
      for (const veil of layerGroups.partial) {
        if (intersects(veil.bounds, viewport)) ctx.fill(veil.path)
      }
      ctx.globalAlpha = 1
    }
    const municipalLayer = layerGroups?.layer.grain === 'municipality'
    if (level !== 'states' || municipalLayer) {
      const ramp = Math.min(1, (transform.k - 2.5) / 1.5) * 0.45
      ctx.globalAlpha = municipalLayer ? Math.max(LAYER_BORDER_ALPHA, ramp) : ramp
      for (const border of regionBorders) {
        if (intersects(border.bounds, viewport))
          stroke(border.path, colors['muted-foreground'], 0.6)
      }
      ctx.globalAlpha = 1
    }
    let revealing = false
    if (transform.k >= 8) {
      for (const border of localBorders) {
        if (!intersects(border.bounds, viewport)) continue
        const reveal = reducedMotion.matches
          ? 1
          : Math.min(1, Math.max(0, (performance.now() - border.appearedAt) / 240))
        revealing ||= reveal < 1
        const opacity = Math.min(1, (transform.k - 8) / 2) * reveal
        ctx.globalAlpha = opacity * 0.3
        stroke(border.subdivisions, colors['muted-foreground'], 0.5)
        ctx.globalAlpha = opacity * 0.8
        stroke(border.places, colors['muted-foreground'], 0.8)
      }
      ctx.globalAlpha = 1
    }
    stroke(stateBorders, colors['muted-foreground'], 0.85)
    const selected = shapes.get(selectedId ?? '')
    if (selected) highlight(selected, 0.18, 1.7)
    if (hovered && hovered !== selected) highlight(hovered, 0.12, 1.4)
    if (revealing) scheduleDraw()
    if (!ready) {
      ready = true
      callbacks.onReady?.()
      if (pendingFit) {
        pendingFit = false
        animation = requestAnimationFrame(() => fit(selectedId))
      }
    }
  }

  function scheduleDraw() {
    if (!frame) frame = requestAnimationFrame(draw)
  }

  function clearHover() {
    cancelAnimationFrame(hoverFrame)
    hoverFrame = 0
    hovered = undefined
    callbacks.onHover(null)
    canvas.style.cursor = dragging ? 'grabbing' : 'grab'
  }

  function requestDetails(view: ZoomTransform) {
    if (data.countryCode !== 'US' || view.k < 4) return
    const viewport: Bounds = [view.invert([0, 0]), view.invert([width, height])]
    const codes = states
      .filter((shape) => intersects(shape.bounds, viewport))
      .map((shape) => shape.feature.properties.stateCode)
    const key = codes.join(',')
    if (key !== detailView) {
      detailView = key
      callbacks.onDetails?.(codes)
    }
  }

  const behavior = zoom<HTMLCanvasElement, unknown>()
    .scaleExtent([1, MAX_ZOOM])
    .clickDistance(5)
    .duration(0)
    .on('start', (event: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
      if (event.sourceEvent) cancelAnimationFrame(animation)
      dragging = true
      clearHover()
      scheduleDraw()
    })
    .on('zoom', (event: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
      if (event.sourceEvent) cancelAnimationFrame(animation)
      transform = event.transform
      if (event.sourceEvent) requestDetails(transform)
      scheduleDraw()
    })
    .on('end', () => {
      dragging = false
      scheduleDraw()
      canvas.style.cursor = 'grab'
      requestDetails(transform)
      callbacks.onZoom(transform.k)
    })

  function move(target: ZoomTransform) {
    cancelAnimationFrame(animation)
    clearHover()
    requestDetails(target)
    if (target.k === transform.k && target.x === transform.x && target.y === transform.y) {
      dragging = false
      scheduleDraw()
      callbacks.onZoom(transform.k)
      return
    }
    if (reducedMotion.matches) {
      element.call(behavior.transform, target)
      return
    }
    const start = transform
    const time = performance.now()
    dragging = true
    function step(now: number) {
      // RAF timestamps can precede a transition started later in that same frame.
      const progress = Math.max(0, Math.min((now - time) / 260, 1))
      const eased = 1 - (1 - progress) ** 3
      // Animate outside D3's event lifecycle so React is notified only at the end.
      transform = zoomIdentity
        .translate(start.x + (target.x - start.x) * eased, start.y + (target.y - start.y) * eased)
        .scale(start.k + (target.k - start.k) * eased)
      element.property('__zoom', transform)
      scheduleDraw()
      if (progress < 1) animation = requestAnimationFrame(step)
      else {
        dragging = false
        canvas.style.cursor = 'grab'
        callbacks.onZoom(transform.k)
      }
    }
    animation = requestAnimationFrame(step)
  }

  function fit(id: string | null, feature?: MapFeature) {
    selectedId = id
    focusFeature = feature
    if (preparing) {
      pendingFit = true
      return
    }
    if (feature && !shapes.has(feature.properties.id))
      shapes.set(feature.properties.id, projectFeature(feature, projection))
    const shape = shapes.get(id ?? '')
    const target = shape ? fitBounds(shape.bounds, width, height) : { k: 1, x: 0, y: 0 }
    move(zoomIdentity.translate(target.x, target.y).scale(target.k))
  }

  function appendDetails(stateCode: string, projected: Awaited<ReturnType<typeof prepareDetails>>) {
    projectedStates.add(stateCode)
    if (!detailAppearedAt.has(stateCode)) detailAppearedAt.set(stateCode, performance.now())
    places.push(...projected.places)
    subdivisions.push(...projected.subdivisions)
    for (const shape of [...projected.places, ...projected.subdivisions])
      shapes.set(shape.feature.properties.id, shape)
    const state = states.find((shape) => shape.feature.properties.stateCode === stateCode)
    if (state)
      localBorders.push({
        places: projected.placeBorders,
        subdivisions: projected.subdivisionBorders,
        bounds: state.bounds,
        appearedAt: detailAppearedAt.get(stateCode)!,
      })
  }

  function resize() {
    const rect = canvas.getBoundingClientRect()
    const nextRatio = Math.min(devicePixelRatio, 2)
    if (!rect.width || !rect.height) return
    if (width === rect.width && height === rect.height && ratio === nextRatio) return
    const center = scene
      ? projection.invert!(transform.invert([canvas.width / ratio / 2, canvas.height / ratio / 2]))
      : null
    cancelAnimationFrame(animation)
    dragging = false
    clearHover()
    width = rect.width
    height = rect.height
    ratio = nextRatio
    preparing = true
    const version = ++resizeVersion
    geometryTask = prepareScene(data, width, height)
      .then(async (prepared) => {
        if (destroyed || version !== resizeVersion) return
        const projectedDetails = []
        for (const stateCode of ready ? details.values() : []) {
          const projected = await prepareDetails(prepared, stateCode)
          if (destroyed || version !== resizeVersion) return
          projectedDetails.push({ stateCode, projected })
        }
        // The new scene has new paths: the layer groups are rebuilt before the swap.
        const builtLayer = layer
          ? await buildLayerGroups(layer, layerShapes(layer, prepared))
          : null
        if (destroyed || version !== resizeVersion) return
        layerVersion++
        scene = prepared
        projection = prepared.projection
        states = prepared.states
        regions = prepared.regions
        regionBorders = prepared.regionBorders
        stateBorders = prepared.stateBorders
        shapes = new Map(
          [...states, ...regions].map((shape) => [shape.feature.properties.id, shape]),
        )
        if (focusFeature)
          shapes.set(focusFeature.properties.id, projectFeature(focusFeature, projection))
        places = []
        subdivisions = []
        localBorders = []
        projectedStates.clear()
        for (const { stateCode, projected } of projectedDetails) appendDetails(stateCode, projected)
        canvas.width = Math.round(width * ratio)
        canvas.height = Math.round(height * ratio)
        preparing = false
        behavior
          .extent([
            [0, 0],
            [width, height],
          ])
          .translateExtent([
            [-width / 2, -height / 2],
            [width * 1.5, height * 1.5],
          ])
        element.call(behavior)
        const point = center && projection(center)
        const target =
          point && transform.k > 1
            ? zoomIdentity
                .translate(width / 2 - point[0] * transform.k, height / 2 - point[1] * transform.k)
                .scale(transform.k)
            : zoomIdentity
        element.call(behavior.transform, target)
        if (layerGroups !== builtLayer) applyLayer(builtLayer)
        // A layer set during the preparation is built for the new scene.
        if (layer !== (builtLayer?.layer ?? null)) rebuildLayer()
        if (ready && pendingFit) {
          pendingFit = false
          fit(selectedId)
        }
      })
      .catch((error) => {
        if (!destroyed && version === resizeVersion) callbacks.onError?.(error)
      })
  }

  function hit(event: MouseEvent) {
    const rect = canvas.getBoundingClientRect()
    const point: [number, number] = [event.clientX - rect.left, event.clientY - rect.top]
    const [x, y] = transform.invert(point)
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    const layers =
      transform.k >= 8
        ? [places, subdivisions, regions]
        : hitGrain(transform.k, layer?.grain ?? null, selectedId) === 'state'
          ? [states]
          : [regions]
    let shape: Shape | undefined
    for (const layer of layers) {
      shape = layer.find(
        (item) =>
          x >= item.bounds[0][0] &&
          x <= item.bounds[1][0] &&
          y >= item.bounds[0][1] &&
          y <= item.bounds[1][1] &&
          ctx.isPointInPath(item.path, x, y),
      )
      if (shape) break
    }
    ctx.restore()
    return { shape, point }
  }

  element
    .on('mousemove.map', (event: MouseEvent) => {
      if (dragging || preparing) return
      cancelAnimationFrame(hoverFrame)
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0
        const { shape, point } = hit(event)
        canvas.style.cursor = shape ? 'pointer' : 'grab'
        if (hovered !== shape) {
          hovered = shape
          scheduleDraw()
        }
        callbacks.onHover(
          shape ? { area: shape.feature.properties, x: point[0], y: point[1] } : null,
        )
      })
    })
    .on('mouseleave.map', () => {
      clearHover()
      scheduleDraw()
    })
    .on('click.map', (event: MouseEvent) => {
      if (event.defaultPrevented || preparing) return
      const { shape } = hit(event)
      if (shape) callbacks.onSelect(shape.feature.properties)
    })

  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  scheme.addEventListener('change', readColors)
  readColors()
  resize()

  return {
    addDetails: (stateCode) => {
      const existing = detailTasks.get(stateCode)
      if (existing) return existing
      details.add(stateCode)
      const task = (async () => {
        await geometryTask
        if (destroyed || !scene) return
        const currentScene = scene
        const projected = await prepareDetails(currentScene, stateCode)
        if (destroyed) return
        if (currentScene !== scene) {
          await geometryTask
          return
        }
        // A resize may already have included a detail that arrived during preparation.
        if (!projectedStates.has(stateCode)) appendDetails(stateCode, projected)
        clearHover()
        scheduleDraw()
      })().catch((error) => {
        detailTasks.delete(stateCode)
        if (!destroyed) callbacks.onError?.(error)
        throw error
      })
      detailTasks.set(stateCode, task)
      return task
    },
    fit,
    scale: (factor) => {
      if (preparing) return
      const k = Math.max(1, Math.min(MAX_ZOOM, transform.k * factor))
      const [x, y] = transform.invert([width / 2, height / 2])
      move(zoomIdentity.translate(width / 2 - x * k, height / 2 - y * k).scale(k))
    },
    pan: (x, y) => {
      if (preparing) return
      cancelAnimationFrame(animation)
      element.call(behavior.translateBy, x / transform.k, y / transform.k)
    },
    setLayer: (next) => {
      if (next === layer) return
      layer = next
      if (!preparing) rebuildLayer()
    },
    destroy: () => {
      destroyed = true
      cancelAnimationFrame(frame)
      cancelAnimationFrame(hoverFrame)
      cancelAnimationFrame(animation)
      observer.disconnect()
      scheme.removeEventListener('change', readColors)
      element.on('.zoom', null).on('.map', null)
    },
  }
}
