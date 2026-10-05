import type { CountryCode } from './map-countries'
import type { Area } from './map-data'

const parameters = {
  state: 'state',
  municipality: 'municipality',
  county: 'county',
  place: 'place',
  subdivision: 'subdivision',
} as const

export function readLocation(url: URL, basePath = '/') {
  const countryCode: CountryCode =
    url.pathname.slice(basePath.length).replace(/\/$/, '') === 'us' ? 'US' : 'BR'
  const levels: [Area['type'], number][] =
    countryCode === 'BR'
      ? [
          ['municipality', 7],
          ['state', 2],
        ]
      : [
          ['place', 7],
          ['subdivision', 10],
          ['county', 5],
          ['state', 2],
        ]
  for (const [type, length] of levels) {
    const geoid = url.searchParams.get(parameters[type])
    if (geoid && /^[0-9]+$/.test(geoid) && geoid.length === length) {
      return { countryCode, selectionId: countryCode === 'BR' ? geoid : `US:${type}:${geoid}` }
    }
  }
  return { countryCode, selectionId: null }
}

export function locationURL(url: URL, countryCode: CountryCode, area: Area | null, basePath = '/') {
  const next = new URL(url)
  next.pathname = `${basePath}${countryCode.toLowerCase()}`
  for (const parameter of [
    ...Object.values(parameters),
    'estado',
    'municipio',
    'condado',
    'localidade',
    'subdivisao',
  ])
    next.searchParams.delete(parameter)
  if (area && area.countryCode === countryCode) {
    next.searchParams.set('state', area.stateCode)
    if (area.type !== 'state') next.searchParams.set(parameters[area.type], area.geoid)
  }
  return `${next.pathname}${next.search}${next.hash}`
}
