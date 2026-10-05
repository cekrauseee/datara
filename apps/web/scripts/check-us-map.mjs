import { geoPath } from 'd3-geo'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  areaLabel,
  readDetails,
  readMap,
  readSearchIndex,
  searchAreas,
} from '../src/features/map/map-data.ts'
import { createProjection } from '../src/features/map/map-geometry.ts'

const root = new URL('../public/maps/us/2025/', import.meta.url)
const read = async (name) => JSON.parse(await readFile(new URL(name, root), 'utf8'))
const manifest = await read('manifest.json')
const topology = await read('national.json')
const data = readMap(topology)
const index = readSearchIndex(await read('search.json'))
assert.throws(() => readSearchIndex([{ id: 'US:place:123', stateCode: '../' }]), /Invalid search/)
assert.equal(data.states.length, 51)
assert.equal(data.regions.length, 3144)
assert.equal(index.length, manifest.counts.place.included + manifest.counts.cousub.included)
assert.equal(new Set(index.map((a) => a.id)).size, index.length)
assert.ok(!data.states.some((f) => ['60', '66', '69', '72', '78'].includes(f.properties.stateCode)))
const projection = createProjection('US').fitSize([1000, 700], {
  type: 'FeatureCollection',
  features: data.states,
})
const path = geoPath(projection)
const all = new Map()
function check(f) {
  const a = f.properties
  assert.ok(!all.has(a.id), a.id)
  all.set(a.id, a)
  assert.equal(a.countryCode, 'US')
  assert.match(a.geoid, /^\d+$/)
  assert.equal(a.stateCode, a.geoid.slice(0, 2))
  assert.ok(a.name && a.officialName && a.stateAbbr, a.id)
  assert.ok(path.bounds(f).flat().every(Number.isFinite), a.id)
  assert.ok(path.area(f) > 0, a.id)
}
for (const f of [...data.states, ...data.regions]) check(f)
for (const stateCode of manifest.stateCodes) {
  const detail = readDetails(await read(`details/${stateCode}.json`), stateCode)
  assert.equal(detail.places.length, manifest.inventory[stateCode].places)
  assert.equal(detail.subdivisions.length, manifest.inventory[stateCode].subdivisions)
  assert.equal(
    data.regions.filter((f) => f.properties.stateCode === stateCode).length,
    manifest.inventory[stateCode].counties,
  )
  for (const f of [...detail.places, ...detail.subdivisions]) {
    assert.equal(f.properties.stateCode, stateCode)
    check(f)
  }
}
for (const area of index) assert.equal(all.get(area.id)?.name, area.name)
const ny = all.get('US:place:3651000')
assert.equal(ny.name, 'New York')
assert.equal(ny.placeCode, '51000')
assert.ok(!('countyCode' in ny))
assert.equal(areaLabel(ny), 'Cidade')
assert.equal(all.get('US:state:02').name, 'Alaska')
assert.equal(all.get('US:state:15').name, 'Hawaii')
assert.equal(areaLabel(all.get('US:state:11')), 'Distrito federal')
assert.ok(searchAreas(index, 'new york ny').some((a) => a.id === ny.id))
assert.ok(
  searchAreas(index, 'paradise nv').some(
    (a) => a.type === 'place' && areaLabel(a) === 'Localidade estatística',
  ),
)
assert.ok(index.some((a) => a.type === 'subdivision' && areaLabel(a) === 'Township'))
assert.ok(
  [...all.values()].some((a) => a.type === 'county' && areaLabel(a) === 'Cidade independente'),
)
// Every state boundary is made from the county arcs, including Alaska and Hawaii.
const arcIds = (g) => g.arcs.flat(Infinity).map((id) => (id < 0 ? ~id : id))
for (const state of topology.objects.states.geometries) {
  const counts = new Map()
  for (const county of topology.objects.regions.geometries.filter(
    (g) => g.properties.stateCode === state.properties.stateCode,
  )) {
    for (const arc of arcIds(county)) counts.set(arc, (counts.get(arc) ?? 0) + 1)
  }
  assert.deepEqual(
    new Set(arcIds(state)),
    new Set([...counts].filter(([, n]) => n === 1).map(([arc]) => arc)),
    state.properties.name,
  )
}
for (const source of manifest.sources) {
  assert.equal(source.records, manifest.counts[source.layer].source)
  assert.equal(
    source.records,
    manifest.counts[source.layer].included + manifest.counts[source.layer].excludedTerritories,
  )
  assert.match(source.sha256, /^[a-f0-9]{64}$/)
  assert.ok(
    source.bytes > 0 && source.downloadedAt && source.url.startsWith('https://www2.census.gov/'),
  )
}
console.log(
  `US checks passed: ${all.size} projected geometries, all state inventories, search, GEOIDs, administrative distinctions and shared boundaries`,
)
