// Run on the Vite page: await import('/scripts/check-map-browser.mjs').then(m => m.checkMap())
import { createMap } from '../src/features/map/map-canvas.ts'
import { countries } from '../src/features/map/map-countries.ts'
import { readDetails, readMap } from '../src/features/map/map-data.ts'

export async function checkMap(countryCode = 'BR') {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const wait = (ms = 350) => new Promise((resolve) => setTimeout(resolve, ms))
  const data = readMap(await (await fetch(`/${countries[countryCode].map}`)).json())
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:fixed;left:-10000px;width:1000px;height:700px'
  document.body.append(canvas)
  const ctx = canvas.getContext('2d')
  const fills = []
  let labels = 0
  let ready = 0
  let zooms = 0
  let scale = 1
  const fill = ctx.fill.bind(ctx)
  ctx.fill = (...args) => {
    fills.push([ctx.fillStyle, ctx.globalAlpha])
    fill(...args)
  }
  ctx.fillText = ctx.strokeText = () => {
    labels++
  }
  const controls = createMap(canvas, data, {
    onReady() {
      ready++
    },
    onSelect() {},
    onHover() {},
    onZoom(k) {
      zooms++
      scale = k
    },
  })
  try {
    for (let i = 0; i < 100 && !ready; i++) await wait(25)
    assert(ready === 1, 'Ready must fire after the first draw')
    assert(zooms === 1, 'Initial ResizeObserver must not rebuild the map twice')
    const baseColor = fills[0][0]
    fills.length = 0
    controls.scale(4)
    await wait()
    assert(ready === 1, 'Zoom must not repeat the ready notification')
    assert(scale === 4 && zooms === 2, 'Notify React once per animated zoom')
    controls.pan(100, 50)
    await wait()
    assert(
      fills.every(([color, alpha]) => color === baseColor && alpha === 1),
      'Land color must stay opaque and stable during zoom and pan',
    )
    assert(labels === 0, 'No geographic labels should be drawn')
    canvas.style.width = '800px'
    await wait()
    assert(scale === 4, 'Resize must preserve zoom')
    if (countryCode === 'US') {
      const detail = readDetails(await (await fetch('/maps/us/2025/details/36.json')).json(), '36')
      await controls.addDetails(detail.stateCode)
      assert(scale === 4, 'Loading details must preserve the viewport')
    }
    controls.fit(countryCode === 'BR' ? '3550308' : 'US:place:3651000')
    await wait()
    assert(scale > 4 && scale <= 100, 'Municipality selection must fit its bounds')
    controls.scale(100)
    await wait()
    assert(scale === 100, 'Enforce maximum zoom')
    controls.fit(null)
    await wait()
    assert(scale === 1, 'Reset must return to Brazil')
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -20,
        ctrlKey: true,
        clientX: -9500,
        clientY: 350,
        bubbles: true,
        cancelable: true,
      }),
    )
    await wait()
    assert(scale > 1, 'Trackpad pinch (Ctrl+wheel) must zoom')
    controls.scale(2)
    controls.destroy()
    const count = fills.length
    await wait()
    assert(fills.length === count, 'Destroy must cancel pending draws and animations')
    return 'Canvas checks passed: stable colors, no labels, coalesced zoom, resize, municipality fit, zoom limits, trackpad pinch and cleanup'
  } finally {
    controls.destroy()
    canvas.remove()
  }
}

// Call while hovering the map, including near viewport edges and with long place names.
export function checkTooltip() {
  const tooltip = document.querySelector('[role="tooltip"]')
  if (!tooltip) throw new Error('Hover a place before checking its tooltip')
  const bounds = tooltip.parentElement.getBoundingClientRect()
  const rect = tooltip.getBoundingClientRect()
  if (
    rect.left < bounds.left ||
    rect.top < bounds.top ||
    rect.right > bounds.right ||
    rect.bottom > bounds.bottom
  ) {
    throw new Error('Tooltip extends beyond the map')
  }
  for (const element of [tooltip, ...tooltip.querySelectorAll('*')]) {
    if (
      element.scrollWidth > element.clientWidth + 1 ||
      element.scrollHeight > element.clientHeight + 1
    ) {
      throw new Error('Tooltip content is clipped')
    }
  }
  return 'Tooltip content and viewport bounds passed'
}
