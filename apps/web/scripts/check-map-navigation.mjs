// On the Vite page: await import('/scripts/check-map-navigation.mjs').then(async m => [await m.checkCache(), await m.checkNavigation()])
import {
  loadCountryMap,
  loadDetailFeature,
  loadMapDetails,
  loadSearchIndex,
} from '../src/features/map/map-cache.ts'
import { navigateMap } from '../src/features/map/use-map-location.ts'

const activeRoot = () => document.querySelector('[data-map-country]:not([hidden])') ?? document

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await wait(25)
  }
  throw new Error('Navigation did not settle')
}

export async function checkCache() {
  for (const load of [() => loadCountryMap('US'), loadSearchIndex, () => loadMapDetails('36')]) {
    const first = load(),
      concurrent = load()
    assert(first === concurrent, 'Concurrent requests must share the same promise')
    const value = await first
    assert(
      load() === first && (await load()) === value,
      'Prepared data and requests must be reused',
    )
  }
  let previous
  for (let i = 0; i < 2; i++) {
    const request = loadMapDetails('99')
    assert(request !== previous, 'Failed entries must be evicted so a retry is possible')
    previous = request
    let failed = false
    try {
      await request
    } catch {
      failed = true
    }
    assert(failed, 'A failed request must reject')
  }
  return 'Memory cache checks passed: request deduplication, decoded data reuse and failure eviction'
}

export async function checkNavigation() {
  const brazil = await loadCountryMap('BR')
  const sp = brazil.regions.find((f) => f.properties.id === '3550308').properties
  navigateMap('BR', sp)
  await until(() => activeRoot().querySelector('[aria-current=page]')?.textContent === sp.name)
  assert(
    location.pathname === '/br' &&
      new URL(location.href).searchParams.get('municipality') === sp.geoid,
    'Brazil URL must contain its selection',
  )
  const index = await loadSearchIndex()
  const ny = index.find((a) => a.id === 'US:place:3651000')
  navigateMap('US', ny)
  await until(
    () =>
      activeRoot().querySelector('[aria-current=page]')?.textContent === ny.name &&
      activeRoot().querySelector('canvas')?.__zoom?.k > 10,
  )
  assert(
    location.pathname === '/us' && new URL(location.href).searchParams.get('place') === ny.geoid,
    'US URL must contain its selection',
  )
  history.back()
  await until(
    () =>
      location.pathname === '/br' &&
      activeRoot().querySelector('[aria-current=page]')?.textContent === sp.name,
  )
  history.forward()
  await until(
    () =>
      location.pathname === '/us' &&
      activeRoot().querySelector('[aria-current=page]')?.textContent === ny.name,
  )
  await wait(400)
  for (const [country, origin, destination] of [
    ['US', ny, index.find((a) => a.name === 'Yonkers' && a.type === 'place')],
    ['BR', sp, brazil.regions.find((f) => f.properties.id === '3534401').properties],
  ]) {
    navigateMap(country, origin)
    await until(
      () => activeRoot().querySelector('[aria-current=page]')?.textContent === origin.name,
    )
    await wait(400)
    const canvas = activeRoot().querySelector('canvas')
    const start = canvas.__zoom.k
    const samples = []
    navigateMap(country, destination)
    const end = performance.now() + 500
    while (performance.now() < end) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      samples.push(canvas.__zoom.k)
    }
    assert(
      Math.min(...samples) >= Math.min(start, samples.at(-1)) - 0.01,
      `${country}: nearby selection must not zoom out to the parent state`,
    )
    assert(
      activeRoot().querySelector('[aria-current=page]')?.textContent === destination.name,
      `${country}: wrong destination`,
    )
  }
  return 'Navigation checks passed: deep selections, history back/forward and nearby-city transitions in Brazil and the US'
}

export async function checkInitialAnimationAndReveal() {
  const { createMap } = await import('../src/features/map/map-canvas.ts')
  const { prepareScene, prepareDetails } = await import('../src/features/map/map-projection.ts')
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
  for (const country of ['BR', 'US']) {
    const data = await loadCountryMap(country)
    const focus = country === 'US' ? await loadDetailFeature('36', 'US:place:3651000') : undefined
    for (let pass = 0; pass < 2; pass++) {
      const canvas = document.createElement('canvas')
      canvas.style.cssText = 'position:fixed;left:-10000px;width:1130px;height:600px'
      document.body.append(canvas)
      let resolveReady, rejectReady, firstZoom
      const ready = new Promise((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      const controls = createMap(canvas, data, {
        onSelect() {},
        onHover() {},
        onZoom() {},
        onError: rejectReady,
        onReady() {
          firstZoom = canvas.__zoom.k
          resolveReady()
        },
      })
      try {
        controls.fit(focus?.properties.id ?? '3550308', focus)
        await ready
        const values = []
        const end = performance.now() + 450
        while (performance.now() < end) {
          await new Promise((resolve) => requestAnimationFrame(resolve))
          values.push(canvas.__zoom.k)
        }
        assert(
          firstZoom === 1,
          `${country}: first paint must show the country, including with a cached projection`,
        )
        assert(values.at(-1) > 1, `${country}: initial selection must be reached`)
        if (!reducedMotion)
          assert(
            values.some((k) => k > 1 && k < values.at(-1)),
            `${country}: initial selection must animate`,
          )
        const first = prepareScene(data, 1130, 600)
        assert(first === prepareScene(data, 1130, 600), 'Projected scenes must be reused')
      } finally {
        controls.destroy()
        canvas.remove()
      }
    }
  }
  const data = await loadCountryMap('US')
  const detail = await loadMapDetails('36')
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:fixed;left:-10000px;width:1130px;height:600px'
  document.body.append(canvas)
  let resolveReady, rejectReady
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const controls = createMap(canvas, data, {
    onSelect() {},
    onHover() {},
    onZoom() {},
    onReady: resolveReady,
    onError: rejectReady,
  })
  try {
    await ready
    controls.fit('US:county:36061')
    await wait(350)
    const scene = await prepareScene(data, 1130, 600)
    const projected = await prepareDetails(scene, detail)
    const context = canvas.getContext('2d')
    const stroke = context.stroke.bind(context)
    const opacity = []
    context.stroke = (path, ...args) => {
      if (path === projected.placeBorders) opacity.push(context.globalAlpha)
      return stroke(path, ...args)
    }
    await controls.addDetails(detail)
    await wait(400)
    if (!reducedMotion)
      assert(
        opacity.some((alpha) => alpha > 0 && alpha < 0.75),
        'Late detail boundaries must fade in',
      )
    assert(opacity.at(-1) >= 0.79, 'Detail boundaries must reach their final opacity')
  } finally {
    controls.destroy()
    canvas.remove()
  }
  return 'Initial view and reveal checks passed: country-first zoom with cold/warm projections, projection reuse and gradual detail boundaries'
}

export async function checkCountryState() {
  const { navigateCountry } = await import('../src/features/map/use-map-location.ts')
  const brazil = await loadCountryMap('BR')
  const sp = brazil.regions.find((f) => f.properties.id === '3550308').properties
  navigateMap('BR', sp)
  await until(() => activeRoot().querySelector('[aria-current=page]')?.textContent === sp.name)
  await wait(400)
  const brazilCanvas = activeRoot().querySelector('canvas')
  brazilCanvas.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }))
  await wait(350)
  brazilCanvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  await wait(100)
  const brView = { ...brazilCanvas.__zoom }
  const brURL = location.pathname + location.search
  const input = activeRoot().querySelector('input[id^="map-search-"]')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Campinas')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(50)
  const query = input.value
  navigateCountry('US')
  await until(
    () =>
      location.pathname === '/us' &&
      activeRoot().getAttribute('data-map-country') === 'US' &&
      activeRoot().querySelector('canvas[aria-hidden=false]'),
  )
  const index = await loadSearchIndex()
  const ny = index.find((a) => a.id === 'US:place:3651000')
  navigateMap('US', ny)
  await until(
    () =>
      activeRoot().querySelector('[aria-current=page]')?.textContent === ny.name &&
      activeRoot().querySelector('canvas')?.__zoom?.k > 10,
  )
  await wait(500)
  const usCanvas = activeRoot().querySelector('canvas')
  usCanvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  await wait(100)
  const usView = { ...usCanvas.__zoom }
  const usURL = location.pathname + location.search
  navigateCountry('BR')
  await until(
    () =>
      location.pathname === '/br' &&
      activeRoot().getAttribute('data-map-country') === 'BR' &&
      activeRoot().querySelector('canvas[aria-hidden=false]'),
  )
  assert(activeRoot().querySelector('canvas') === brazilCanvas, 'Reuse the existing Brazil canvas')
  assert(location.pathname + location.search === brURL, 'Restore Brazil selection in the URL')
  assert(
    JSON.stringify(brazilCanvas.__zoom) === JSON.stringify(brView),
    'Restore Brazil zoom and pan exactly',
  )
  assert(
    activeRoot().querySelector('input[id^="map-search-"]').value === query,
    'Preserve the country search text',
  )
  navigateCountry('US')
  await until(
    () => location.pathname === '/us' && activeRoot().getAttribute('data-map-country') === 'US',
  )
  assert(activeRoot().querySelector('canvas') === usCanvas, 'Reuse the existing US canvas')
  assert(location.pathname + location.search === usURL, 'Restore US selection in the URL')
  assert(
    JSON.stringify(usCanvas.__zoom) === JSON.stringify(usView),
    `Restore US zoom and pan exactly: ${JSON.stringify(usView)} -> ${JSON.stringify(usCanvas.__zoom)}`,
  )
  assert(
    document.querySelectorAll('[data-map-country]:not([hidden])').length === 1,
    'Only one country page can be visible',
  )
  const ids = [...document.querySelectorAll('[id]')].map((element) => element.id)
  assert(new Set(ids).size === ids.length, 'Retained country pages must not duplicate element IDs')
  return 'Country state checks passed: selection URLs, exact zoom/pan, search text, retained canvases and unique IDs'
}
