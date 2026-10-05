import { geoMercator, geoPath } from 'd3-geo'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { readMap, searchAreas } from '../src/features/map/map-data.ts'
import {
  detailLevel,
  fitBounds,
  intersects,
  tooltipPosition,
} from '../src/features/map/map-geometry.ts'

assert.equal(detailLevel(1), 'states')
assert.equal(detailLevel(2.5), 'regions')
assert.equal(detailLevel(6), 'regions')
assert.equal(detailLevel(100), 'regions')
const fit = fitBounds(
  [
    [100, 100],
    [200, 200],
  ],
  1000,
  700,
)
assert.equal(150 * fit.k + fit.x, 500)
assert.equal(150 * fit.k + fit.y, 350)
assert.ok(fit.k >= 1 && fit.k <= 100)
assert.ok(
  intersects(
    [
      [0, 0],
      [2, 2],
    ],
    [
      [1, 1],
      [3, 3],
    ],
  ),
)
assert.ok(
  !intersects(
    [
      [0, 0],
      [2, 2],
    ],
    [
      [3, 3],
      [4, 4],
    ],
  ),
)

const topology = JSON.parse(await readFile(new URL('../public/maps/brazil.json', import.meta.url)))
const data = readMap(topology)
assert.equal(data.states.length, 27)
assert.ok(data.regions.length >= 5500)
const features = [...data.states, ...data.regions]
assert.equal(new Set(features.map((feature) => feature.properties.id)).size, features.length)
const areas = features.map((feature) => feature.properties)
assert.ok(searchAreas(areas, 'sao paulo sp').some((area) => area.id === '3550308'))
assert.ok(searchAreas(areas, 'campinas sp').some((area) => area.id === '3509502'))
assert.equal(searchAreas(areas, 'lugar inexistente').length, 0)

const projection = geoMercator().fitExtent(
  [
    [50, 50],
    [950, 650],
  ],
  { type: 'FeatureCollection', features: data.states },
)
const path = geoPath(projection)
for (const feature of features) {
  assert.ok(feature.properties.name && feature.properties.stateAbbr, feature.properties.id)
  assert.ok(path.bounds(feature).flat().every(Number.isFinite), feature.properties.id)
  assert.ok(path.area(feature) > 0, feature.properties.id)
}
console.log('Map checks passed: detail levels, search, viewport fitting and all IBGE geometries')

// State outlines must contain only arcs from their municipalities, never an independent outline.
for (const state of topology.objects.states.geometries) {
  const arcIds = (geometry) => geometry.arcs.flat(Infinity).map((id) => (id < 0 ? ~id : id))
  const counts = new Map()
  for (const area of topology.objects.regions.geometries.filter(
    (area) => area.properties.stateAbbr === state.properties.stateAbbr,
  )) {
    for (const arc of arcIds(area)) counts.set(arc, (counts.get(arc) ?? 0) + 1)
  }
  assert.deepEqual(
    new Set(arcIds(state)),
    new Set([...counts].filter(([, count]) => count === 1).map(([arc]) => arc)),
    state.properties.name,
  )
}
for (const [width, height] of [
  [320, 480],
  [1440, 900],
]) {
  for (const [x, y] of [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ]) {
    const position = tooltipPosition(x, y, width, height, 256, 100)
    assert.ok(position.left >= 12 && position.left + 256 <= width - 12)
    assert.ok(position.top >= 12 && position.top + 100 <= height - 12)
  }
}
assert.throws(() => readMap({}), /Incomplete map/)
console.log('Shared state boundaries and tooltip edge checks passed')
