// Run on the Vite page: const m = await import('/scripts/check-map-layer-browser.mjs')
// then console.log(await m.checkMapLayer(), await m.checkMapLayerContrast())
// and, with VITE_API_URL pointing at a running API, console.log(await m.checkMapLayerPage()).
import { clear } from '../src/features/elections/api-cache.ts'
import { API_URL } from '../src/features/elections/api-client.ts'
import { classifyMap, legendCounts } from '../src/features/elections/map-classes.ts'
import { createMap } from '../src/features/map/map-canvas.ts'
import { countries } from '../src/features/map/map-countries.ts'
import { readMap } from '../src/features/map/map-data.ts'
import { LAYER_BORDER_ALPHA, PARTIAL_VEIL_ALPHA } from '../src/features/map/map-layer.ts'

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const wait = (ms = 350) => new Promise((resolve) => setTimeout(resolve, ms))
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
// Two animation frames: a hidden pane throttles them, so timers alone would race the canvas.
const settle = async () => {
  await frame()
  await frame()
  await wait(50)
}
async function until(predicate, label = 'Condition', timeout = 10_000) {
  const end = performance.now() + timeout
  while (performance.now() < end) {
    await wait(25)
    if (predicate()) return
  }
  throw new Error(`${label} did not settle`)
}

export const FIXTURE_LEADERS = [
  ['#ee2d35', 'PT'],
  ['#4466e7', 'PL'],
  ['#198b43', 'MDB'],
  ['#987e04', 'PSB'],
  ['#0090a8', 'PP'],
  ['#a569d5', 'PODE'],
]

export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Synthetic leader map in the `MapResponse` format from the mesh: six leader colours, three per
 * state, margins across the four bands, 3 % ties, 5 % without data and 10 % partial;
 * `level: 'state'` gives the 27-state companion.
 */
export function makeFixture(
  data,
  level = 'municipality',
  { publicationId = 'fixture', contestId = 'BR-2026-1:6257:1:br', seed = 2026 } = {},
) {
  const random = mulberry32(seed)
  const candidates = Object.fromEntries(
    FIXTURE_LEADERS.map(([color, party], index) => [
      `fx:${party}`,
      {
        id: `fx:${party}`,
        officialId: `${10 + index}`,
        number: `${10 + index}`,
        displayName: `CANDIDATO ${party}`,
        color,
        photoUrl: null,
        party: { number: `${10 + index}`, abbreviation: party, name: party, displayName: null },
        contestId,
      },
    ]),
  )
  const ids = Object.keys(candidates)
  // Three leaders per state (dominant, challenger, minor), as in a real first round.
  const trios = new Map()
  for (const state of data.states) {
    const a = Math.floor(random() * ids.length)
    const b = (a + 1 + Math.floor(random() * (ids.length - 1))) % ids.length
    let c = (a + 1 + Math.floor(random() * (ids.length - 1))) % ids.length
    if (c === b) c = (b + 1) % ids.length
    if (c === a) c = (a + 1) % ids.length
    trios.set(state.properties.stateCode, [ids[a], ids[b], ids[c]])
  }
  const features = level === 'state' ? data.states : data.regions
  const items = features.map(({ properties }) => {
    const [a, b, c] = trios.get(properties.stateCode)
    const roll = random()
    const value = Math.round(random() * 50_000) + 50
    const base = {
      areaId: `fx:${properties.id}`,
      featureId: properties.id,
      value,
      state: 'available',
      sourceKind: 'EA20',
      basis: 'recordedCandidateVotesSum',
      leaders: [a],
      tie: false,
      complete: random() >= 0.1,
      margin: random() * 40,
    }
    if (level === 'state') return { ...base, complete: true }
    if (roll < 0.05)
      return {
        ...base,
        value: null,
        state: 'unavailable',
        leaders: [],
        complete: false,
        margin: null,
      }
    if (roll < 0.08) return { ...base, leaders: [a, b], tie: true, margin: 0 }
    const pick = random()
    return { ...base, leaders: [pick < 0.7 ? a : pick < 0.92 ? b : c] }
  })
  return {
    publicationId,
    coverage: { scope: 'pilot', complete: false },
    contestId,
    scopeAreaId: 'br',
    level,
    metric: 'leader',
    candidateId: null,
    items,
    candidates,
    omittedWithoutGeometry: 1,
    missingResults: 0,
  }
}

/** Serves the fixture for `/map?` requests of the API; other requests pass through. */
export function installFixture(data, { seed } = {}) {
  const original = window.fetch
  const requests = []
  window.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input), location.href)
    if (!url.href.startsWith(API_URL.origin) || !/\/map$/.test(url.pathname))
      return original(input, init)
    requests.push(url.href)
    const contestId = url.pathname.split('/')[2] ?? 'BR-2026-1:6257:1:br'
    const fixture = makeFixture(data, url.searchParams.get('level') ?? 'municipality', {
      publicationId: url.searchParams.get('publicationId') ?? 'fixture',
      contestId: decodeURIComponent(contestId),
      seed,
    })
    return new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return {
    requests,
    restore() {
      window.fetch = original
    },
  }
}

function normalizeColor(value) {
  const ctx = document.createElement('canvas').getContext('2d')
  ctx.fillStyle = value
  return ctx.fillStyle
}

function spy(ctx) {
  const record = { fills: [], strokes: [], frames: 0, addPathMs: 0, addPaths: 0 }
  const fill = ctx.fill.bind(ctx)
  ctx.fill = (...args) => {
    record.fills.push([ctx.fillStyle, ctx.globalAlpha])
    fill(...args)
  }
  const stroke = ctx.stroke.bind(ctx)
  ctx.stroke = (...args) => {
    record.strokes.push([ctx.strokeStyle, ctx.globalAlpha, ctx.lineWidth])
    stroke(...args)
  }
  const clearRect = ctx.clearRect.bind(ctx)
  ctx.clearRect = (...args) => {
    record.frames++
    clearRect(...args)
  }
  const addPath = Path2D.prototype.addPath
  Path2D.prototype.addPath = function (...args) {
    const start = performance.now()
    addPath.apply(this, args)
    record.addPathMs += performance.now() - start
    record.addPaths++
  }
  record.restore = () => {
    Path2D.prototype.addPath = addPath
  }
  return record
}

export async function checkMapLayer() {
  const data = readMap(await (await fetch(`/${countries.BR.map}`)).json())
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:fixed;left:-10000px;width:1000px;height:700px'
  document.body.append(canvas)
  const ctx = canvas.getContext('2d')
  const record = spy(ctx)
  const style = getComputedStyle(canvas)
  const token = (name) => normalizeColor(style.getPropertyValue(`--${name}`).trim())
  const muted = token('muted')
  const primary = token('primary')
  let ready = 0
  let scale = 1
  let hover = null
  const layers = []
  const controls = createMap(canvas, data, {
    onReady: () => ready++,
    onSelect() {},
    onHover: (value) => (hover = value),
    onZoom: (k) => (scale = k),
    onLayer: (info) => layers.push(info),
  })
  const hoverAt = async (x, y) => {
    hover = null
    const rect = canvas.getBoundingClientRect()
    canvas.dispatchEvent(
      new MouseEvent('mousemove', { clientX: rect.left + x, clientY: rect.top + y, bubbles: true }),
    )
    await until(() => hover !== null, 'Hover', 15_000)
    return hover.area
  }
  const resolved = (color) => normalizeColor(typeof color === 'string' ? color : token(color.token))
  try {
    await until(() => ready === 1, 'Ready')
    await settle()
    record.fills.length = 0
    const municipal = classifyMap(makeFixture(data, 'municipality'))
    const counts = legendCounts(municipal, null)
    assert(
      counts.total === 5571 && municipal.layer.fills.size + counts.missing === 5571,
      'Fixture covers 5,571 municipalities',
    )
    assert(
      counts.tie > 0 && counts.partial > 0 && counts.missing > 0,
      'Fixture has ties, partial and missing items',
    )

    // Municipal layer at national zoom: one frame, merged groups, veils and municipal borders.
    const framesBefore = record.frames
    record.fills.length = 0
    record.strokes.length = 0
    const started = performance.now()
    controls.setLayer(municipal.layer)
    await until(() => layers.length === 1, 'Layer built', 15_000)
    const buildMs = performance.now() - started
    await settle()
    const info = layers[0]
    assert(
      info.fills === municipal.layer.fills.size && info.missing === 0,
      'Every fill matched a shape',
    )
    assert(
      record.frames - framesBefore === 1,
      `A single frame follows setLayer (got ${record.frames - framesBefore})`,
    )
    const baseFills = record.fills.filter(([color, alpha]) => color === muted && alpha === 1)
    const veils = record.fills.filter(
      ([color, alpha]) => color === muted && alpha === PARTIAL_VEIL_ALPHA,
    )
    const classFills = record.fills.length - baseFills.length - veils.length
    assert(baseFills.length === 27, `27 base fills at 1× (got ${baseFills.length})`)
    assert(
      classFills === info.groups && info.groups > 0 && info.groups <= 400,
      `Class fills equal the visible groups (${classFills} vs ${info.groups}, limit 400)`,
    )
    assert(veils.length > 0 && veils.length <= 27, 'Partial veils are merged per state')
    for (const cls of municipal.layer.classes.values()) {
      const color = resolved(cls.color)
      assert(
        record.fills.some(([fillColor, alpha]) => fillColor === color && alpha === cls.alpha),
        `Class ${cls.id} painted in its colour and alpha`,
      )
    }
    assert(
      record.strokes.some(
        ([, alpha, width]) => alpha === LAYER_BORDER_ALPHA && Math.abs(width - 0.6) < 1e-3,
      ),
      'Municipal borders stroked at national zoom with the layer',
    )
    assert(!record.fills.some(([color]) => color === primary), 'No primary fill with a layer')

    // Hit testing: states at 1×, municipalities inside a framed state below 2.5×.
    const state = await hoverAt(500, 350)
    assert(state.type === 'state', `Hover at 1× returns a state (got ${state.type})`)
    await settle()
    assert(
      !record.fills.some(([color]) => color === primary),
      'Hover highlight is outline only with a layer',
    )
    controls.fit('13')
    await until(() => scale > 1, 'Amazonas framed')
    const framed = scale
    // Below 2.5× with the state still selected (large states frame there on narrow viewports).
    controls.scale(2 / scale)
    await until(() => Math.abs(scale - 2) < 0.01, 'Zoom below 2.5×')
    await settle()
    const municipality = await hoverAt(500, 350)
    assert(
      municipality.type === 'municipality',
      `Hover inside a selected state returns a municipality (got ${municipality.type})`,
    )
    controls.fit(null)
    await until(() => scale === 1, 'Brazil framed')
    await settle()
    const outside = await hoverAt(500, 350)
    assert(outside.type === 'state', 'Hover at 1× without selection returns a state again')

    // State layer: 27 fills at most, no municipal borders at 1×.
    const stateLayer = classifyMap(makeFixture(data, 'state')).layer
    record.fills.length = 0
    record.strokes.length = 0
    controls.setLayer(stateLayer)
    await until(() => layers.length === 2, 'State layer built')
    await settle()
    assert(layers[1].fills === 27 && layers[1].groups <= 27, 'State layer merges 27 fills')
    assert(
      !record.strokes.some(([, alpha]) => alpha === LAYER_BORDER_ALPHA),
      'State grain keeps the zoom rule for municipal borders',
    )

    // Removing the layer restores the base (hover cleared first: its highlight fills primary).
    canvas.dispatchEvent(new MouseEvent('mouseleave'))
    await until(() => hover === null, 'Hover cleared')
    await settle()
    record.fills.length = 0
    record.strokes.length = 0
    controls.setLayer(null)
    await until(() => layers.length === 3 && layers[2] === null, 'Layer removed')
    await settle()
    assert(
      record.fills.every(([color, alpha]) => color === muted && alpha === 1),
      'Only base fills without a layer',
    )
    assert(
      !record.strokes.some(([, alpha]) => alpha === LAYER_BORDER_ALPHA),
      'No municipal borders at 1× without a layer',
    )

    // Destroy cancels a pending build.
    controls.setLayer(municipal.layer)
    controls.destroy()
    const frames = record.frames
    await settle()
    await wait(300)
    assert(
      layers.length === 3 && record.frames === frames,
      'Destroy cancels the layer build and draws',
    )
    return {
      summary:
        'Map layer canvas checks passed: merged groups, veils, borders, hit testing, state grain, removal and cleanup',
      groups: info.groups,
      fills: info.fills,
      veils: veils.length,
      ties: counts.tie,
      partial: counts.partial,
      missing: counts.missing,
      amazonasScale: Math.round(framed * 100) / 100,
      buildWallMs: Math.round(buildMs),
      addPathCpuMs: Math.round(record.addPathMs * 10) / 10,
      addPaths: record.addPaths,
    }
  } finally {
    controls.destroy()
    record.restore()
    canvas.remove()
  }
}

// OKLab lightness of an sRGB pixel.
function lightness([r, g, b]) {
  const linear = (c) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const [R, G, B] = [linear(r), linear(g), linear(b)]
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
}

/** Composes each band over both muted bases and requires monotonic lightness steps ≥ 0.04. */
export function checkMapLayerContrast() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const compose = (base, color, alpha) => {
    ctx.globalAlpha = 1
    ctx.fillStyle = base
    ctx.fillRect(0, 0, 1, 1)
    ctx.globalAlpha = alpha
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    return lightness(ctx.getImageData(0, 0, 1, 1).data)
  }
  const ramps = {
    leader: [0.35, 0.55, 0.78, 1],
    margin: [0.2, 0.45, 0.7, 0.9],
    turnout: [0.12, 0.28, 0.45, 0.62, 0.8],
    candidate: [0.2, 0.4, 0.6, 0.8, 1],
  }
  const themes = [
    {
      name: 'light',
      base: 'oklch(0.97 0 0)',
      foreground: 'oklch(0.145 0 0)',
      mutedForeground: 'oklch(0.556 0 0)',
    },
    {
      name: 'dark',
      base: 'oklch(0.269 0 0)',
      foreground: 'oklch(0.985 0 0)',
      mutedForeground: 'oklch(0.708 0 0)',
    },
  ]
  const report = []
  for (const theme of themes) {
    const base = compose(theme.base, theme.base, 1)
    const cases = [
      ...['#ee2d35', '#4466e7', '#198b43', '#987e04'].flatMap((color) => [
        [color, 'leader', ramps.leader],
        [color, 'candidate', ramps.candidate],
      ]),
      [theme.foreground, 'margin', ramps.margin],
      [theme.foreground, 'turnout', ramps.turnout],
    ]
    for (const [color, ramp, alphas] of cases) {
      const steps = alphas.map((alpha) => compose(theme.base, color, alpha))
      const direction = Math.sign(steps[0] - base)
      let previous = base
      for (const [index, step] of steps.entries()) {
        const delta = (step - previous) * direction
        assert(
          delta >= 0.04 - 1e-9,
          `${theme.name} ${color} ${ramp} band ${index + 1}: ΔL ${delta.toFixed(3)} < 0.04`,
        )
        previous = step
      }
      report.push(`${theme.name} ${color} ${ramp}: ${steps.map((l) => l.toFixed(2)).join(' ')}`)
    }
    const tie = compose(theme.base, theme.mutedForeground, 0.6)
    assert(Math.abs(tie - base) >= 0.04, `${theme.name} tie class distinct from the base`)
  }
  return {
    summary: 'Contrast checks passed: monotonic lightness, ΔL ≥ 0.04 per band in both themes',
    report,
  }
}

const activeRoot = () => document.querySelector('[data-map-country]:not([hidden])') ?? document
const legend = () => activeRoot().querySelector('[data-map-legend]')
function go(path) {
  history.pushState(null, '', path)
  dispatchEvent(new Event('map:navigate'))
}
const legendTotal = () => Number(legend()?.dataset.mapLegendTotal ?? NaN)
const rowCounts = () =>
  [...(legend()?.querySelectorAll('[data-count]') ?? [])].map((row) => Number(row.dataset.count))

/** Page check with the fixture served to `/map?` requests; the other requests reach the API. */
export async function checkMapLayerPage() {
  const data = readMap(await (await fetch(`/${countries.BR.map}`)).json())
  const fixture = installFixture(data)
  const start = location.pathname + location.search
  try {
    clear()
    go('/br?collection=elections&office=president')
    await until(
      () => legend()?.dataset.mapLegend === 'ready' && legendTotal() === 5571,
      'Municipal legend',
      20_000,
    )
    const counts = rowCounts()
    const sum = counts.reduce((total, count) => total + count, 0)
    assert(sum === 5571, `Legend counts add up to 5,571 (got ${sum})`)
    assert(
      legend().getAttribute('role') === 'region' &&
        legend().getAttribute('aria-label') === 'Legenda do mapa',
      'Legend region',
    )
    const toggle = legend().querySelector('[aria-label="Grão"]')
    const states = [...toggle.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Estados'),
    )
    states.click()
    await until(
      () => new URL(location.href).searchParams.get('level') === 'state',
      'level=state in the URL',
    )
    await until(
      () => legend()?.dataset.mapLegend === 'ready' && legendTotal() === 27,
      'State legend',
      20_000,
    )
    assert(
      rowCounts().reduce((total, count) => total + count, 0) === 27,
      'State counts add up to 27',
    )
    const municipalities = [...toggle.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Municípios'),
    )
    municipalities.click()
    await until(
      () => !new URL(location.href).searchParams.has('level'),
      'Municipality grain is the URL default',
    )
    await until(() => legendTotal() === 5571, 'Municipal legend again', 20_000)

    // Tooltip at national zoom: the state fill of the companion map.
    // The canvas ignores hover while it rebuilds the municipal layer after the grain toggle, so
    // the pointer keeps moving over the centre, as a real pointer would, until the tooltip shows.
    const canvas = activeRoot().querySelector('canvas')
    const rect = canvas.getBoundingClientRect()
    await until(
      () => {
        canvas.dispatchEvent(
          new MouseEvent('mousemove', {
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            bubbles: true,
          }),
        )
        return document.querySelector('[role="tooltip"] [data-map-hover-leader]')
      },
      'Tooltip with leader',
      5000,
    )
    const leader = document.querySelector('[role="tooltip"] [data-map-hover-leader]').textContent
    assert(
      /CANDIDATO \w+ · \w+/.test(leader),
      `Tooltip names the leader and party (got "${leader}")`,
    )
    canvas.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))

    const publications = new Set(
      fixture.requests.map((href) => new URL(href).searchParams.get('publicationId')),
    )
    assert(
      publications.size === 1 && !publications.has(null),
      'Every map request carries the same publicationId',
    )
    go('/us')
    await wait(300)
    assert(!legend(), 'No legend on /us')
    go('/br')
    await wait(300)
    assert(!legend(), 'No legend without an office')
    return {
      summary:
        'Map layer page checks passed: legend counts, grain toggle, tooltip, publication pinning, /us and /br without legend',
      mapRequests: fixture.requests.length,
    }
  } finally {
    fixture.restore()
    clear()
    go(start)
  }
}
