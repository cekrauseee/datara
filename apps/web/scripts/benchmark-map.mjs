// Run on the Vite page: await import('/scripts/benchmark-map.mjs').then(m => m.benchmarkMap())
import { loadCountryMap } from '../src/features/map/map-cache.ts'
import { navigateMap } from '../src/features/map/use-map-location.ts'

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
export async function benchmarkMap() {
  const results = []
  for (const [country, id, label, skipPaint] of [
    ['US', 'US:state:25', 'US Massachusetts cold', false],
    ['US', 'US:state:25', 'US Massachusetts warm', false],
    ['US', 'US:state:25', 'US without paint', true],
    ['BR', '35', 'BR São Paulo', false],
  ]) {
    navigateMap(country, null)
    await ready(country)
    await wait(400)
    const data = await loadCountryMap(country)
    const state = data.states.find((f) => f.properties.id === id).properties
    const ctx = root().querySelector('canvas').getContext('2d')
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
    navigateMap(country, state)
    while (performance.now() - start < 2500) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const now = performance.now()
      gaps.push({ at: now - start, ms: now - last })
      last = now
    }
    observer.disconnect()
    frameObserver.disconnect()
    ctx.fill = originalFill
    ctx.stroke = originalStroke
    const summarize = (items) => {
      const sorted = items.map((x) => x.ms).sort((a, b) => a - b)
      return {
        frames: items.length,
        p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
        max: Math.round(sorted.at(-1) ?? 0),
        over33ms: items.filter((x) => x.ms > 33).length,
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
    })
    await wait(500)
  }
  return results
}
