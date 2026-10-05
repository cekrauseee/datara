import { geoArea } from 'd3-geo'
import { mkdir, writeFile } from 'node:fs/promises'

import { buildMap, mapOutline } from './map-topology.mjs'

const base = 'https://servicodados.ibge.gov.br/api'
const year = 2025
const url = (division) =>
  `${base}/v4/malhas/paises/BR?formato=application/vnd.geo+json&qualidade=minima&intrarregiao=${division}&periodo=${year}`

async function read(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status}: ${url}`)
  return response.json()
}

const [municipalities, locations, stateNames] = await Promise.all([
  read(url('municipio')),
  read(`${base}/v1/localidades/municipios`),
  read(`${base}/v1/localidades/estados`),
])

const names = new Map(locations.map((location) => [String(location.id), location.nome]))
const ufs = new Map(stateNames.map((state) => [String(state.id), state]))

function prepare(feature) {
  const id = feature.properties.codarea
  const state = ufs.get(id.slice(0, 2))
  const name = names.get(id)
  if (!state || !name) throw new Error(`Missing IBGE metadata: ${id}`)
  if (!['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) {
    throw new Error(`Unexpected geometry: ${id}`)
  }
  // D3 uses clockwise exterior rings, opposite to RFC 7946 GeoJSON.
  if (geoArea(feature) > 2 * Math.PI) {
    const polygons =
      feature.geometry.type === 'Polygon'
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates
    for (const polygon of polygons) for (const ring of polygon) ring.reverse()
  }
  return {
    type: 'Feature',
    properties: {
      id,
      geoid: id,
      countryCode: 'BR',
      name,
      stateCode: id.slice(0, 2),
      stateAbbr: state.sigla,
      type: 'municipality',
    },
    geometry: feature.geometry,
  }
}

if (stateNames.length !== 27 || municipalities.features.length < 5500) {
  throw new Error('Incomplete IBGE map')
}

const data = {
  year,
  source: 'IBGE',
  sources: [
    url('municipio'),
    `${base}/v1/localidades/municipios`,
    `${base}/v1/localidades/estados`,
  ],
  states: stateNames.map((state) => ({
    properties: {
      id: String(state.id),
      geoid: String(state.id),
      countryCode: 'BR',
      name: state.nome,
      stateCode: String(state.id),
      stateAbbr: state.sigla,
      type: 'state',
    },
  })),
  regions: municipalities.features.map(prepare),
}

const directory = new URL('../public/maps/', import.meta.url)
await mkdir(directory, { recursive: true })
const map = buildMap(data)
await writeFile(new URL('brazil.json', directory), JSON.stringify(map))
await writeFile(new URL('brazil-outline.svg', directory), mapOutline(map))
console.log(`IBGE ${year}: ${data.states.length} UFs, ${data.regions.length} municipalities`)
