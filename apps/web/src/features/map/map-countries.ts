export type CountryCode = 'BR' | 'US'

export const countries = {
  BR: {
    name: 'Brasil',
    map: 'maps/brazil.json',
    outline: 'maps/brazil-outline.svg',
    source: 'IBGE',
    sourceUrl:
      'https://www.ibge.gov.br/geociencias/organizacao-do-territorio/malhas-territoriais/15774--malhas.html',
    searchPlaceholder: 'Buscar município ou estado',
    codeLabel: 'Código IBGE',
  },
  US: {
    name: 'Estados Unidos',
    map: 'maps/us/2025/national.json',
    outline: 'maps/us/2025/outline.svg',
    source: 'U.S. Census Bureau',
    sourceUrl:
      'https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.2025.html',
    searchPlaceholder: 'Buscar estado, condado ou localidade',
    codeLabel: 'GEOID',
  },
} as const
