import { feature, mesh } from 'topojson-client'
import type { GeometryCollection, Topology } from 'topojson-specification'

import type { CountryCode } from './map-countries'

export type Area = {
  id: string
  countryCode: CountryCode
  geoid: string
  name: string
  officialName?: string
  stateCode: string
  stateAbbr: string
  type: 'state' | 'municipality' | 'county' | 'place' | 'subdivision'
}

export type MapFeature = {
  type: 'Feature'
  properties: Area
  geometry:
    | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] }
}
export type MapTopology = Topology<{
  states: GeometryCollection<Area>
  regions: GeometryCollection<Area>
}> & { countryCode: CountryCode; year: number; source: string }
export type DetailTopology = Topology<{
  places: GeometryCollection<Area>
  subdivisions: GeometryCollection<Area>
}> & { countryCode: 'US'; stateCode: string }
export type MapDetails = {
  stateCode: string
  places: MapFeature[]
  subdivisions: MapFeature[]
  placeBorders: ReturnType<typeof mesh>
  subdivisionBorders: ReturnType<typeof mesh>
}
export type MapData = {
  countryCode: CountryCode
  year: number
  source: string
  states: MapFeature[]
  regions: MapFeature[]
  stateBorders: ReturnType<typeof mesh>
  regionBorders: ReturnType<typeof mesh>[]
}

export type MapViewData = Pick<MapData, 'countryCode' | 'year' | 'source'> & {
  states: { properties: Area }[]
  regions: { properties: Area }[]
}

export function readMap(map: MapTopology): MapData {
  const stateCount = map.countryCode === 'BR' ? 27 : map.countryCode === 'US' ? 51 : 0
  if (
    !stateCount ||
    map.type !== 'Topology' ||
    !Array.isArray(map.arcs) ||
    map.objects?.states?.geometries?.length !== stateCount ||
    !(map.objects?.regions?.geometries?.length >= (map.countryCode === 'BR' ? 5500 : 3000))
  )
    throw new Error('Incomplete map')
  const states = feature(map, map.objects.states).features as MapFeature[]
  return {
    countryCode: map.countryCode,
    year: map.year,
    source: map.source,
    states,
    regions: feature(map, map.objects.regions).features as MapFeature[],
    stateBorders: mesh(map, map.objects.states),
    regionBorders: states.map((state) =>
      mesh(
        map,
        {
          type: 'GeometryCollection',
          geometries: map.objects.regions.geometries.filter(
            (area) =>
              area.type !== null && area.properties?.stateCode === state.properties.stateCode,
          ),
        },
        (a, b) => a !== b,
      ),
    ),
  }
}

export function readDetails(map: DetailTopology, stateCode: string): MapDetails {
  if (
    map.type !== 'Topology' ||
    map.countryCode !== 'US' ||
    map.stateCode !== stateCode ||
    !Array.isArray(map.arcs) ||
    !Array.isArray(map.objects?.places?.geometries) ||
    !Array.isArray(map.objects?.subdivisions?.geometries)
  )
    throw new Error('Invalid map details')
  return {
    stateCode,
    places: feature(map, map.objects.places).features as MapFeature[],
    subdivisions: feature(map, map.objects.subdivisions).features as MapFeature[],
    placeBorders: mesh(map, map.objects.places),
    subdivisionBorders: mesh(map, map.objects.subdivisions),
  }
}

export function readSearchIndex(value: unknown): Area[] {
  if (!Array.isArray(value)) throw new Error('Invalid search index')
  return value.map((record) => {
    if (!record || typeof record !== 'object') throw new Error('Invalid search entry')
    const area = record as Partial<Area>
    if (
      typeof area.id !== 'string' ||
      !/^US:(place|subdivision):[0-9]+$/.test(area.id) ||
      !area.name ||
      typeof area.name !== 'string' ||
      typeof area.officialName !== 'string' ||
      typeof area.stateCode !== 'string' ||
      !/^[0-9]{2}$/.test(area.stateCode) ||
      typeof area.stateAbbr !== 'string' ||
      !/^[A-Z]{2}$/.test(area.stateAbbr) ||
      !['place', 'subdivision'].includes(area.type ?? '')
    )
      throw new Error('Invalid search entry')
    const geoid = area.id.split(':')[2]
    if (!geoid.startsWith(area.stateCode) || area.id !== `US:${area.type}:${geoid}`)
      throw new Error('Invalid search identity')
    return { ...area, countryCode: 'US', geoid } as Area
  })
}

export function areaLabel(area: Area) {
  if (area.type === 'state')
    return area.stateCode === '11' && area.countryCode === 'US' ? 'Distrito federal' : 'Estado'
  if (area.type === 'municipality') return 'Município'
  const suffix = area.officialName ?? ''
  for (const [ending, label] of [
    [' CDP', 'Localidade estatística'],
    [' County', 'Condado'],
    [' Parish', 'Paróquia'],
    [' Borough', 'Borough'],
    [' borough', 'Borough'],
    [' Census Area', 'Área censitária'],
    [' Planning Region', 'Região de planejamento'],
    [' township', 'Township'],
    [' town', 'Town'],
    [' village', 'Vila'],
    [' city', area.type === 'county' ? 'Cidade independente' : 'Cidade'],
    [' CCD', 'Divisão censitária'],
    [' UT', 'Território não organizado'],
  ])
    if (suffix.endsWith(ending)) return label
  return area.type === 'county'
    ? 'Equivalente de condado'
    : area.type === 'subdivision'
      ? 'Subdivisão local'
      : 'Localidade'
}

export function searchAreas(areas: Area[], query: string) {
  const normalize = (value: string) =>
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('pt-BR')
  const words = normalize(query).trim().split(/\s+/)
  return areas
    .filter((area) =>
      words.every((word) =>
        normalize(`${area.name} ${area.stateAbbr} ${area.geoid}`).includes(word),
      ),
    )
    .sort(
      (a, b) =>
        Number(b.type === 'state') - Number(a.type === 'state') ||
        a.name.localeCompare(b.name, 'pt-BR'),
    )
    .slice(0, 30)
}
