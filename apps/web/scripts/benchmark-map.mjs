// Run on the Vite page: await import('/scripts/benchmark-map.mjs').then(m => m.benchmarkMap())
// The layer cases need VITE_API_URL pointing at a running API (session and contests); the map
// payloads come from the synthetic fixture of 5,571 municipalities.
import { clear } from '../src/features/elections/api-cache.ts'
import { loadCountryMap } from '../src/features/map/map-cache.ts'
import { navigateMap } from '../src/features/map/use-map-location.ts'
import { installFixture } from './check-map-layer-browser.mjs'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = () => document.querySelector('[data-map-country]:not([hidden])')
async function ready(country) {
  for (let i = 0; i < 200; i++) {
    if (root()?.dataset.mapCountry === country && root().querySelector('canvas[aria-hidden=false]'))
      return
    await wait(25)
  }
  throw new Error('Map did not become ready')
}
async function until(predicate, label, timeout = 20_000) {
  const end = performance.now() + timeout
  while (performance.now() < end) {
    await wait(25)
    if (predicate()) return
  }
  throw new Error(`${label} did not settle`)
}
function go(path) {
  history.pushState(null, '', path)
  dispatchEvent(new Event('map:navigate'))
}
const heapMB = () =>
  performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null

/** `filter` selects one case by exact label or several by substring (one run per visible window). */
export async function benchmarkMap(filter = '') {
  const results = []
  const cases = [
    { country: 'US', id: 'US:state:25', label: 'US Massachusetts cold' },
    { country: 'US', id: 'US:state:25', label: 'US Massachusetts warm' },
    { country: 'US', id: 'US:state:25', label: 'US without paint', skipPaint: true },
    { country: 'BR', id: '35', label: 'BR São Paulo' },
    { country: 'BR', id: '35', label: 'BR São Paulo layer', layer: true },
    { country: 'BR', id: null, label: 'BR national pan layer', layer: true, pan: true },
  ]
  const selected = cases.some((item) => item.label === filter)
    ? cases.filter((item) => item.label === filter)
    : cases.filter((item) => item.label.includes(filter))
  for (const { country, id, label, skipPaint, layer, pan } of selected) {
    navigateMap(country, null)
    await ready(country)
    await wait(400)
    const data = await loadCountryMap(country)
    const state = id ? data.states.find((f) => f.properties.id === id).properties : null
    let fixture = null
    const heapBefore = heapMB()
    if (layer) {
      clear()
      fixture = installFixture(data)
      go('/br?collection=elections&office=president')
      await until(
        () => root().querySelector('[data-map-legend="ready"]')?.dataset.mapLegendTotal === '5571',
        'Municipal layer',
      )
      await wait(400)
    }
    const heapAfter = heapMB()
    const canvas = root().querySelector('canvas')
    const ctx = canvas.getContext('2d')
    const originalFill = ctx.fill,
      originalStroke = ctx.stroke
    let paintTime = 0,
      paintCalls = 0
    for (const name of ['fill', 'stroke']) {
      const original = ctx[name]
      ctx[name] = function (...args) {
        const start = performance.now()
        const result = skipPaint ? undefined : original.apply(this, args)
        paintTime += performance.now() - start
        paintCalls++
        return result
      }
    }
    const longTasks = []
    const observer = new PerformanceObserver((list) =>
      longTasks.push(...list.getEntries().map((e) => e.duration)),
    )
    observer.observe({ type: 'longtask' })
    const slowFrames = []
    const frameObserver = new PerformanceObserver((list) =>
      slowFrames.push(
        ...list.getEntries().map((e) => ({
          ms: Math.round(e.duration),
          scripts: e.scripts?.map((s) => ({
            name: s.sourceFunctionName,
            ms: Math.round(s.duration),
            url: s.sourceURL.split('/').at(-1),
          })),
        })),
      ),
    )
    frameObserver.observe({ type: 'long-animation-frame' })
    const gaps = []
    let last = performance.now()
    const start = last
    let frames = 0
    if (pan) canvas.focus()
    else navigateMap(country, state)
    while (performance.now() - start < 2500) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const now = performance.now()
      gaps.push({ at: now - start, ms: now - last })
      last = now
      // Keyboard pan of 80 px per frame, alternating direction every second.
      if (pan)
        canvas.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: Math.floor(frames++ / 60) % 2 ? 'ArrowRight' : 'ArrowLeft',
            bubbles: true,
          }),
        )
    }
    observer.disconnect()
    frameObserver.disconnect()
    ctx.fill = originalFill
    ctx.stroke = originalStroke
    // A hidden or background pane throttles animation frames to about one per second; such
    // gaps without a long task are reported apart instead of counted as slow frames.
    const summarize = (all) => {
      const throttled = all.filter((x) => x.ms >= 500 && !longTasks.some((ms) => ms >= 500))
      const items = all.filter((x) => !throttled.includes(x))
      const sorted = items.map((x) => x.ms).sort((a, b) => a - b)
      return {
        frames: items.length,
        p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
        max: Math.round(sorted.at(-1) ?? 0),
        over33ms: items.filter((x) => x.ms > 33).length,
        ...(throttled.length ? { throttled: throttled.length } : {}),
      }
    }
    results.push({
      case: label,
      animation: summarize(gaps.filter((x) => x.at < 450)),
      complete: summarize(gaps),
      longTasks: longTasks.map(Math.round),
      slowFrames,
      paintCalls,
      paintCpuMs: Math.round(paintTime),
      ...(layer ? { heapMB: { before: heapBefore, withLayer: heapAfter } } : {}),
    })
    if (fixture) {
      fixture.restore()
      clear()
      go('/br')
    }
    await wait(500)
  }
  return results
}
