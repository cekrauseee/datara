// Data layer painted over the base map: fills keyed by feature ID, classes keyed by colour and
// band. The canvas merges the fills of each (class × state) into one Path2D, so a frame costs a
// few hundred fills instead of thousands, while hit testing keeps the per-feature paths.
import type { Bounds } from './map-geometry'
import { budgeted, type Shape } from './map-projection'

/** Absolute colour from the API, or a theme token read from the canvas at draw time. */
export type LayerColor = string | { token: 'foreground' | 'muted-foreground' }

export type LayerClass = {
  id: string
  color: LayerColor
  alpha: number
  label: string
  /** Draw order; lower first. */
  order: number
}

export type LayerFill<M = unknown> = {
  featureId: string
  classId: string
  /** Drawn at 60 % of the class alpha (a `--muted` veil at 40 % over the class fill). */
  partial: boolean
  meta: M
}

export type LayerGrain = 'state' | 'municipality'

export type MapLayer<M = unknown> = {
  key: string
  grain: LayerGrain
  classes: Map<string, LayerClass>
  fills: Map<string, LayerFill<M>>
}

export type LayerGroup = {
  classId: string
  stateCode: string
  color: LayerColor
  alpha: number
  order: number
  path: Path2D
  bounds: Bounds
  count: number
}

export type LayerGroups = {
  layer: MapLayer
  /** One merged path per (class × state), in class order. */
  groups: LayerGroup[]
  /** One merged path per state with the partial fills of that state. */
  partial: { stateCode: string; path: Path2D; bounds: Bounds; count: number }[]
  /** Fills matched to a shape. */
  fills: number
  /** Fills without a shape in the scene (ignored). */
  missing: number
}

export const PARTIAL_VEIL_ALPHA = 0.4

/** Alpha of the municipal borders with a municipal layer, at any zoom. */
export const LAYER_BORDER_ALPHA = 0.25

/**
 * Hit testing by zoom: states until 2.5×, municipalities from there. With a municipal layer and a
 * selected area, municipalities answer at any zoom, since large states frame below 2.5×.
 */
export function hitGrain(scale: number, grain: LayerGrain | null, selectedId: string | null) {
  return scale >= 2.5 || (grain === 'municipality' && selectedId !== null)
    ? 'municipality'
    : 'state'
}

export function resolveLayerColor(color: LayerColor, colors: Record<string, string>) {
  return typeof color === 'string' ? color : colors[color.token]
}

function extend(bounds: Bounds, other: Bounds) {
  bounds[0][0] = Math.min(bounds[0][0], other[0][0])
  bounds[0][1] = Math.min(bounds[0][1], other[0][1])
  bounds[1][0] = Math.max(bounds[1][0], other[1][0])
  bounds[1][1] = Math.max(bounds[1][1], other[1][1])
}

function copy(bounds: Bounds): Bounds {
  return [
    [bounds[0][0], bounds[0][1]],
    [bounds[1][0], bounds[1][1]],
  ]
}

/** Merges the fills of `layer` over `shapes` under the frame budget of the scene preparation. */
export async function buildLayerGroups(
  layer: MapLayer,
  shapes: Shape[],
  signal?: AbortSignal,
): Promise<LayerGroups> {
  const groups = new Map<string, LayerGroup>()
  const partial = new Map<string, LayerGroups['partial'][number]>()
  let fills = 0
  await budgeted(
    shapes,
    (shape) => {
      const { id, stateCode } = shape.feature.properties
      const fill = layer.fills.get(id)
      if (!fill) return
      const cls = layer.classes.get(fill.classId)
      if (!cls) return
      fills++
      const key = `${fill.classId}\n${stateCode}`
      let group = groups.get(key)
      if (!group) {
        group = {
          classId: fill.classId,
          stateCode,
          color: cls.color,
          alpha: cls.alpha,
          order: cls.order,
          path: new Path2D(),
          bounds: copy(shape.bounds),
          count: 0,
        }
        groups.set(key, group)
      }
      group.path.addPath(shape.path)
      extend(group.bounds, shape.bounds)
      group.count++
      if (!fill.partial) return
      let veil = partial.get(stateCode)
      if (!veil) {
        veil = { stateCode, path: new Path2D(), bounds: copy(shape.bounds), count: 0 }
        partial.set(stateCode, veil)
      }
      veil.path.addPath(shape.path)
      extend(veil.bounds, shape.bounds)
      veil.count++
    },
    signal,
  )
  return {
    layer,
    groups: [...groups.values()].sort((a, b) => a.order - b.order),
    partial: [...partial.values()],
    fills,
    missing: layer.fills.size - fills,
  }
}
