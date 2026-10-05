import { geoArea } from 'd3-geo'
import mapshaper from 'mapshaper'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { feature } from 'topojson-client'
import { topology } from 'topojson-server'

import { buildMap, mapOutline } from './map-topology.mjs'

const year = 2025
const codes =
  '01 02 04 05 06 08 09 10 11 12 13 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 44 45 46 47 48 49 50 51 53 54 55 56'.split(
    ' ',
  )
const cache = join(tmpdir(), 'datara-us-data')
const output = new URL('../public/maps/us/2025/', import.meta.url)
await mkdir(cache, { recursive: true })
await mkdir(new URL('details/', output), { recursive: true })
const sources = []
for (const layer of ['state', 'county', 'place', 'cousub']) {
  const name = `cb_${year}_us_${layer}_500k`
  const url = `https://www2.census.gov/geo/tiger/GENZ${year}/shp/${name}.zip`
  const file = join(cache, `${name}.zip`)
  let bytes, downloadedAt
  try {
    const saved = JSON.parse(await readFile(`${file}.json`, 'utf8'))
    bytes = await readFile(file)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), saved.sha256)
    downloadedAt = saved.downloadedAt
  } catch {
    console.log(`Downloading ${name}`)
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) })
    if (!response.ok) throw new Error(`${response.status}: ${url}`)
    bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(bytes.readUInt32LE(0), 0x04034b50, `Invalid ZIP: ${url}`)
    downloadedAt = new Date().toISOString()
    await writeFile(file, bytes)
  }
  const record = {
    layer,
    url,
    downloadedAt,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
  await writeFile(`${file}.json`, JSON.stringify(record))
  sources.push(record)
  execFileSync('unzip', ['-joq', file, '*.shp', '*.shx', '*.dbf', '*.prj', '*.cpg', '-d', cache])
  record.records = (await readFile(join(cache, `${name}.dbf`))).readUInt32LE(4)
}

// Simplify all layers together so shared edges cannot diverge across zoom levels.
const inputs = ['state', 'county', 'place', 'cousub']
  .map((layer) => `"${join(cache, `cb_${year}_us_${layer}_500k.shp`)}"`)
  .join(' ')
console.log('Projecting NAD83 to WGS84 and preparing shared boundaries')
const result = await mapshaper.applyCommands(
  `-i ${inputs} combine-files -proj wgs84 -simplify interval=300m keep-shapes -o prepared.json format=topojson no-quantization`,
)
const prepared = JSON.parse(result['prepared.json'])
const layers = Object.fromEntries(
  ['state', 'county', 'place', 'cousub'].map((layer) => [
    layer,
    feature(prepared, prepared.objects[`cb_${year}_us_${layer}_500k`]).features,
  ]),
)
for (const source of sources)
  assert.equal(layers[source.layer].length, source.records, `Lost source records: ${source.layer}`)
const stateMetadata = new Map(
  layers.state
    .filter((f) => codes.includes(f.properties.STATEFP))
    .map((f) => [f.properties.STATEFP, f.properties]),
)
assert.equal(stateMetadata.size, 51)

function normalize(f, type) {
  const p = f.properties
  const state = stateMetadata.get(p.STATEFP)
  assert.ok(state && p.GEOID && p.NAME, JSON.stringify({ type, properties: p }))
  assert.ok(f.geometry && ['Polygon', 'MultiPolygon'].includes(f.geometry.type), p.GEOID)
  const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
  for (const polygon of polygons)
    for (const ring of polygon)
      for (const point of ring) {
        assert.ok(point.every(Number.isFinite), p.GEOID)
        point[0] = Math.round(point[0] * 1e7) / 1e7
        point[1] = Math.round(point[1] * 1e7) / 1e7
      }
  if (geoArea(f) > 2 * Math.PI)
    for (const polygon of polygons) for (const ring of polygon) ring.reverse()
  assert.ok(geoArea(f) > 0 && geoArea(f) < 2 * Math.PI, p.GEOID)
  return {
    ...f,
    properties: {
      id: `US:${type}:${p.GEOID}`,
      countryCode: 'US',
      type,
      geoid: p.GEOID,
      name: p.NAME,
      officialName: p.NAMELSAD ?? p.NAME,
      stateCode: p.STATEFP,
      stateAbbr: state.STUSPS,
      sourceYear: year,
      lsad: p.LSAD,
      ...(p.COUNTYFP ? { countyCode: p.COUNTYFP } : {}),
      ...(p.PLACEFP ? { placeCode: p.PLACEFP } : {}),
      ...(p.COUSUBFP ? { subdivisionCode: p.COUSUBFP } : {}),
    },
  }
}
const types = { state: 'state', county: 'county', place: 'place', cousub: 'subdivision' }
const retained = Object.fromEntries(
  Object.entries(layers).map(([layer, features]) => [
    layer,
    features
      .filter((f) => codes.includes(f.properties.STATEFP))
      .map((f) => normalize(f, types[layer])),
  ]),
)
const counts = Object.fromEntries(
  Object.entries(layers).map(([layer, features]) => [
    layer,
    {
      source: features.length,
      included: retained[layer].length,
      excludedTerritories: features.length - retained[layer].length,
    },
  ]),
)
const base = buildMap({
  countryCode: 'US',
  year,
  source: 'U.S. Census Bureau',
  sources: sources.map((s) => s.url),
  states: retained.state,
  regions: retained.county,
})
await writeFile(new URL('national.json', output), JSON.stringify(base))
await writeFile(new URL('outline.svg', output), mapOutline(base))
const index = []
const inventory = {}
for (const state of codes) {
  const places = retained.place.filter((f) => f.properties.stateCode === state)
  const subdivisions = retained.cousub.filter((f) => f.properties.stateCode === state)
  const detail = topology({
    places: { type: 'FeatureCollection', features: places },
    subdivisions: { type: 'FeatureCollection', features: subdivisions },
  })
  await writeFile(
    new URL(`details/${state}.json`, output),
    JSON.stringify({ countryCode: 'US', stateCode: state, year, ...detail }),
  )
  index.push(...places.map((f) => f.properties), ...subdivisions.map((f) => f.properties))
  inventory[state] = {
    counties: retained.county.filter((f) => f.properties.stateCode === state).length,
    places: places.length,
    subdivisions: subdivisions.length,
  }
}
assert.equal(new Set(index.map((a) => a.id)).size, index.length)
assert.ok(
  index.find((a) => a.id === 'US:place:3651000' && !a.countyCode),
  'New York city must not acquire an invented county parent',
)
await writeFile(
  new URL('search.json', output),
  JSON.stringify(
    index.map(({ id, name, officialName, stateCode, stateAbbr, type }) => ({
      id,
      name,
      officialName,
      stateCode,
      stateAbbr,
      type,
    })),
  ),
)
await writeFile(
  new URL('manifest.json', output),
  JSON.stringify(
    {
      year,
      source: 'U.S. Census Bureau',
      crs: 'EPSG:4326',
      inputCrs: 'NAD83 (from .prj)',
      simplification: { intervalMeters: 300, keepShapes: true, sharedAcrossLayers: true },
      scope: '50 states and District of Columbia; territories excluded',
      stateCodes: codes,
      sources,
      counts,
      inventory,
    },
    null,
    2,
  ),
)
console.log(JSON.stringify(counts, null, 2))
