// On the Vite page (any VITE_API_URL: requests to that origin are answered by synthetic responses
// built from the election-panel fixtures, so no API is needed):
// const m = await import('/scripts/check-election-depth.mjs')
// for (const check of Object.values(m)) console.log(await check())
// Covers zones, sections (BU, unavailable, aggregated), the exterior and its localities, the
// regions, the URL rules for `zone`, `section` and `area`, and the pinned publication (asserted
// by the last check, in alphabetical order, over the requests of the whole run).
import { clear } from '../src/features/elections/api-cache.ts'
import { API_URL } from '../src/features/elections/api-client.ts'
import { loadCountryMap } from '../src/features/map/map-cache.ts'
import { navigateMap } from '../src/features/map/use-map-location.ts'

const origin = API_URL.origin
const FIXTURES = '/scripts/fixtures/election-panel'
const PUBLICATION = '2a4cee03-930c-4377-b383-fcb27f9da55d'
const EDITION = 'BR-2026-1'
const PRESIDENT = `${EDITION}:6257:1:br`
const GOVERNOR_AC = `${EDITION}:6259:3:ac`
const COUNCIL = `${EDITION}:6261:25:pe:30015`

const realFetch = window.fetch.bind(window)
const activeRoot = () => document.querySelector('[data-map-country]:not([hidden])') ?? document
const panel = () => activeRoot().querySelector('[data-election-status]')
const field = (name) => panel()?.dataset[name]
const search = () => new URL(location.href).searchParams
const text = () => panel()?.textContent ?? ''
const title = () => panel()?.querySelector('h2')?.textContent ?? ''
const notices = () =>
  [...activeRoot().querySelectorAll('[data-election-warnings] li')].map((node) => node.textContent)
const crumbs = () =>
  [...activeRoot().querySelectorAll('nav[aria-label="Localidade selecionada"] li')]
    .map((node) => node.textContent.trim())
    .filter(Boolean)
const crumbButton = (label) =>
  [...activeRoot().querySelectorAll('nav[aria-label="Localidade selecionada"] button')].find(
    (node) => node.textContent.trim() === label,
  )
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, label = 'Condition', timeout = 10_000) {
  const end = performance.now() + timeout
  while (performance.now() < end) {
    await wait(25)
    if (predicate()) return
  }
  throw new Error(`${label} did not settle (${location.search} · ${text().slice(0, 160)})`)
}
function go(path) {
  history.pushState(null, '', path)
  dispatchEvent(new Event('map:navigate'))
}
const settled = (areaId) => () =>
  field('electionArea') === areaId && field('electionStatus') === 'ready'
async function expandSheet() {
  if (panel()?.dataset.mobileSheet !== 'collapsed') return
  panel().querySelector('button[aria-expanded]').click()
  await until(() => panel()?.dataset.mobileSheet === 'expanded', 'Expanded sheet')
}
async function click(selector, label) {
  await expandSheet()
  await until(() => panel()?.querySelector(selector), label)
  panel().querySelector(selector).click()
}
async function mesh(id) {
  const brazil = await loadCountryMap('BR')
  return [...brazil.states, ...brazil.regions].find((feature) => feature.properties.id === id)
    .properties
}

// Synthetic catalogue: Porto Walter (zone 0004: BU section 0077, section 0080 without BU),
// Brasília (zone 0002: principal 0471 with an unresolved votable, aggregated 0472), the
// exterior with two localities and the five regions.
const fixtures = new Map()
function fixture(name) {
  if (!fixtures.has(name))
    fixtures.set(
      name,
      realFetch(`${FIXTURES}/${name}.json`).then((response) => {
        if (!response.ok) throw new Error(`Fixture ${name} missing (${response.status})`)
        return response.json()
      }),
    )
  return fixtures.get(name)
}
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': `depth-${status}` },
  })
const failure = (status, code, message) =>
  json({ error: { code, message, requestId: `depth-${code}` } }, status)

const area = (id, level, name, extra = {}) => ({
  id,
  level,
  name,
  uf: null,
  municipalityCode: null,
  zoneCode: null,
  sectionCode: null,
  featureId: null,
  parentId: null,
  principalAreaId: null,
  ...extra,
})
const zone = (municipality, uf, code) =>
  area(`${municipality}:${code}`, 'zone', `Zona ${code}`, {
    uf,
    municipalityCode: municipality.split(':')[1],
    zoneCode: code,
    parentId: municipality,
  })
const section = (zoneArea, code, principal = null) =>
  area(`${zoneArea.id}:${code}`, 'section', `Seção ${code}`, {
    uf: zoneArea.uf,
    municipalityCode: zoneArea.municipalityCode,
    zoneCode: zoneArea.zoneCode,
    sectionCode: code,
    parentId: zoneArea.id,
    principalAreaId: principal,
  })
const PORTO_ZONE = zone('ac:01066', 'ac', '0004')
const BSB_ZONE = zone('df:97012', 'df', '0002')
const ABU = area('zz:29262', 'municipality', 'ABU DHABI', {
  uf: 'zz',
  municipalityCode: '29262',
  parentId: 'exterior',
})
const ABIDJA = area('zz:29254', 'municipality', 'ABIDJÃ', {
  uf: 'zz',
  municipalityCode: '29254',
  parentId: 'exterior',
})
const ABU_ZONE = zone('zz:29262', 'zz', '0001')
const NORONHA_ZONE = zone('pe:30015', 'pe', '0004')
const CHILDREN = {
  'ac:01066|zone': [PORTO_ZONE],
  'df:97012|zone': [zone('df:97012', 'df', '0001'), BSB_ZONE],
  'ac:01066:0004|section': [
    section(PORTO_ZONE, '0077'),
    section(PORTO_ZONE, '0078'),
    section(PORTO_ZONE, '0080'),
  ],
  'df:97012:0002|section': [
    section(BSB_ZONE, '0470'),
    section(BSB_ZONE, '0471'),
    section(BSB_ZONE, '0472', 'df:97012:0002:0471'),
  ],
  'exterior|municipality': [ABIDJA, ABU],
  'zz:29262|zone': [ABU_ZONE],
  'pe:30015|zone': [NORONHA_ZONE],
  'region:north|state': [
    area('ac', 'state', 'ACRE', { uf: 'ac', featureId: '12', parentId: 'region:north' }),
  ],
}
const BRASILIA = area('df:97012', 'municipality', 'BRASÍLIA', {
  uf: 'df',
  municipalityCode: '97012',
  featureId: '5300108',
  parentId: 'df',
})

async function list(items, query) {
  const base = await fixture('areas').then((areas) => areas['12'])
  const limit = Number(query.get('limit') ?? 25)
  const offset = Number(query.get('offset') ?? 0)
  return {
    publicationId: PUBLICATION,
    coverage: base.coverage,
    items: items.slice(offset, offset + limit),
    pagination: { limit, offset, total: items.length, hasMore: offset + limit < items.length },
  }
}

async function areasRoute(query) {
  const featureId = query.get('featureId')
  if (featureId === '5300108') return json(await list([BRASILIA], query))
  if (featureId) {
    const areas = await fixture('areas')
    return json(areas[featureId] ?? (await list([], query)))
  }
  if (query.get('uf') === 'zz' && query.get('municipalityCode'))
    return json(
      await list(
        [ABU, ABIDJA].filter((item) => item.municipalityCode === query.get('municipalityCode')),
        query,
      ),
    )
  const parentId = query.get('parentId')
  const children = CHILDREN[`${parentId}|${query.get('level')}`]
  if (!children) return failure(404, 'AREA_NOT_FOUND', 'Area not found in this publication')
  const q = query.get('q')
  const filtered = q
    ? children.filter((item) => (item.level === 'zone' ? item.zoneCode : item.sectionCode) === q)
    : children
  return json(await list(filtered, query))
}

const REGION_STATES = { north: 7, northeast: 9, centralwest: 4, southeast: 4, south: 3 }
async function resultFor(contestId, areaId) {
  if (contestId === COUNCIL) {
    const council = await fixture('results-council-noronha')
    if (areaId === 'pe:30015') return council
    // The zone result keeps the municipal contest and its statuses scoped to `pe:30015`.
    if (areaId === NORONHA_ZONE.id)
      return { ...structuredClone(council), area: NORONHA_ZONE, resultAreaId: NORONHA_ZONE.id }
    return null
  }
  const base = structuredClone(
    await fixture(contestId === GOVERNOR_AC ? 'results-governor-ac' : 'results-president-ac'),
  )
  const make = (areaValue, patch = {}) => ({
    ...base,
    area: areaValue,
    resultAreaId: areaValue.id,
    ...patch,
  })
  const bu = (areaValue, patch = {}) =>
    make(areaValue, {
      officialStatus: 'printed',
      officialStatusLabel: 'Boletim de urna impresso',
      provenance: {
        sourceKind: 'BU',
        sourceIds: ['bu'],
        meaning: 'Printed ballot votes; judicial destination unavailable',
        generatedAt: '2026-10-04T17:10:20',
      },
      totals: {
        ...base.totals,
        eligible: 272,
        turnout: 249,
        abstentions: 23,
        totalVotes: 249,
        validVotes: null,
        nominalVotes: 240,
        legendVotes: 0,
        blankVotes: 8,
        nullVotes: 1,
        noCandidateVotes: null,
        sectionsTotal: 1,
        sectionsCounted: 1,
      },
      summary: { ...base.summary, shareBasis: 'printedNominalVotes' },
      ...patch,
    })
  const unavailable = (areaValue) =>
    make(areaValue, {
      state: 'unavailable',
      complete: false,
      totals: null,
      provenance: null,
      summary: null,
      candidates: [],
      parties: [],
      pagination: { ...base.pagination, total: 0, hasMore: false },
    })
  if (contestId === GOVERNOR_AC) return areaId === 'ac' ? base : null
  if (contestId !== PRESIDENT) return null
  const [portoSections, bsbSections] = [
    CHILDREN['ac:01066:0004|section'],
    CHILDREN['df:97012:0002|section'],
  ]
  switch (areaId) {
    case 'br':
      return fixture('results-president-br')
    case 'ac':
    case 'df':
      return base
    case 'ac:01066':
      return make(area('ac:01066', 'municipality', 'PORTO WALTER', { uf: 'ac' }))
    case 'df:97012':
      return make(BRASILIA)
    case PORTO_ZONE.id:
      return make(PORTO_ZONE)
    case BSB_ZONE.id:
      return make(BSB_ZONE)
    case portoSections[0].id:
      return bu(portoSections[0])
    case portoSections[2].id:
      return unavailable(portoSections[2])
    case bsbSections[1].id:
      return bu(bsbSections[1], {
        unresolvedVotables: [{ number: '55', voteType: '1', partyNumber: '55', votes: 1 }],
      })
    case bsbSections[2].id:
      return bu(bsbSections[2], { state: 'shared', resultAreaId: bsbSections[1].id })
    case 'exterior':
      return make(area('exterior', 'state', 'Exterior', { uf: 'zz', parentId: 'br' }), {
        totals: { ...base.totals, sectionsTotal: 1351, sectionsCounted: 1351 },
      })
    case ABU.id:
      return unavailable(ABU)
    case ABU_ZONE.id:
      return unavailable(ABU_ZONE)
  }
  const region = areaId.match(/^region:([a-z]+)$/)?.[1]
  if (region && REGION_STATES[region])
    return make(area(areaId, 'region', region, { parentId: 'br' }), {
      officialStatus: 'regionComplete',
      officialStatusLabel: 'Soma das UFs completa',
      provenance: {
        sourceKind: 'aggregate',
        sourceIds: ['a'],
        meaning: `Sum of disjoint domestic UF EA20 results (${REGION_STATES[region]}/${REGION_STATES[region]} states); exterior excluded`,
        generatedAt: null,
      },
    })
  return null
}

async function route(url) {
  const { pathname, searchParams: query } = new URL(url)
  if (pathname === '/elections') return json(await fixture('elections'))
  if (pathname === `/elections/${EDITION}/contests`) return json(await fixture('contests'))
  if (pathname === `/elections/${EDITION}/areas`) return areasRoute(query)
  const results = pathname.match(/^\/contests\/(.+)\/results$/)
  if (results) {
    const body = await resultFor(decodeURIComponent(results[1]), query.get('areaId'))
    return body ? json(body) : failure(404, 'AREA_NOT_FOUND', 'Area not found in this publication')
  }
  const map = pathname.match(/^\/contests\/(.+)\/map$/)
  if (map && decodeURIComponent(map[1]) === PRESIDENT && query.get('metric') === 'leader')
    return json(
      await fixture(
        query.get('level') === 'state' ? 'map-president-state' : 'map-president-municipality',
      ),
    )
  return failure(404, 'FIXTURE_NOT_FOUND', `No fixture for ${url}`)
}

let requests = []
// Every API request of every check, for the publication assertion.
const allRequests = []
let override = null
function serve() {
  const previous = window.fetch
  requests = []
  override = null
  clear()
  window.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.startsWith(origin)) return previous(input, init)
    requests.push(url)
    allRequests.push(url)
    if (override) {
      const response = await override(url)
      if (response) return response
    }
    return route(url)
  }
  return () => {
    window.fetch = previous
    override = null
  }
}
const kind = (url) => new URL(url).pathname.split('/').at(-1)
const SECTION_URL =
  '/br?collection=elections&office=president&state=12&municipality=1200393&zone=0004&section=0077'

export async function checkSectionRoundTrip() {
  const restore = serve()
  try {
    go(SECTION_URL)
    await until(settled('ac:01066:0004:0077'), 'Section 0077 panel')
    const params = search()
    assert(
      params.get('zone') === '0004' && params.get('section') === '0077',
      `The section URL is kept (${location.search})`,
    )
    assert(title() === 'Seção 0077 · Seção eleitoral', `Section title (${title()})`)
    assert(text().includes('Zona 0004 · Porto Walter, AC'), 'Section scope line')
    assert(text().includes('Boletim de urna (BU) · base: votos nominais impressos'), 'BU basis')
    assert(text().includes('04/10/2026 17:10 (hora local da urna)'), 'BU local clock')
    assert(text().includes('não registrado nesta publicação'), 'noCandidateVotes null note')
    assert(text().includes('indisponível no BU'), 'validVotes unavailable in a BU')
    assert(!panel().querySelector('[data-depth-list]'), 'No list below a section')
    assert(
      crumbs().join(' > ') === 'Brasil > Acre > Porto Walter > Zona 0004 > Seção 0077',
      `Breadcrumb (${crumbs().join(' > ')})`,
    )
    crumbButton('Zona 0004').click()
    await until(settled('ac:01066:0004'), 'Zone 0004 panel')
    assert(!search().has('section') && search().get('zone') === '0004', 'Zone crumb drops section')
    assert(title() === 'Zona 0004 · Zona eleitoral', `Zone title (${title()})`)
    await until(
      () => panel().querySelector('[data-depth-list="section"] [data-depth-item]'),
      'Section list',
    )
    assert(
      panel().querySelectorAll('[data-depth-item]').length === 3,
      'Three sections listed in zone 0004',
    )
    await click('[data-depth-item="ac:01066:0004:0080"]', 'Section 0080 item')
    await until(settled('ac:01066:0004:0080'), 'Section 0080 panel')
    assert(field('electionResults') === 'unavailable', 'Section 0080 has no BU')
    assert(search().get('section') === '0080', 'Section item writes section')
    crumbButton('Porto Walter').click()
    await until(settled('ac:01066'), 'Municipality panel')
    assert(!search().has('zone') && !search().has('section'), 'Municipality crumb drops the zone')
    await until(
      () => panel().querySelector('[data-depth-list="zone"] [data-depth-item]'),
      'Zone list',
    )
    history.back()
    await until(settled('ac:01066:0004:0080'), 'History back returns to the section')
  } finally {
    restore()
  }
  return 'Section round trip passed: URL kept, BU basis and local clock, printed totals, breadcrumb ancestors, zone and section lists, unavailable section, history'
}

export async function checkSharedSection() {
  const restore = serve()
  try {
    go('/br?collection=elections&office=president&state=53&municipality=5300108&zone=0002')
    await until(settled('df:97012:0002'), 'Zone 0002 panel')
    await until(
      () => panel().querySelector('[data-depth-item="df:97012:0002:0472"] [data-aggregated]'),
      'Aggregated marker',
    )
    const marker = panel().querySelector('[data-depth-item="df:97012:0002:0472"] [data-aggregated]')
    assert(marker.textContent.includes('Seção 0471'), `Aggregated marker (${marker.textContent})`)
    await click('[data-depth-item="df:97012:0002:0472"]', 'Section 0472 item')
    await until(settled('df:97012:0002:0472'), 'Section 0472 panel')
    assert(field('electionResults') === 'shared', 'Section 0472 is shared')
    await until(() => text().includes('Votos contados junto com a Seção 0471'), 'Shared band')
    assert(search().get('section') === '0472', 'The URL stays on the aggregated section')
    assert(crumbs().at(-1) === 'Seção 0472', 'The breadcrumb stays on the aggregated section')
    await click('[data-principal-link="0471"]', 'Principal link')
    await until(settled('df:97012:0002:0471'), 'Section 0471 panel')
    assert(search().get('section') === '0471', 'The link writes section=0471')
    assert(
      text().includes('1 votável sem candidatura verificada: nº 55 (1 voto)'),
      'Unresolved votable note',
    )
  } finally {
    restore()
  }
  return 'Shared section passed: aggregated marker, "Votos contados junto com a Seção 0471", URL and breadcrumb on 0472, link writes section=0471, unresolved votable note'
}

export async function checkInvalidCodes() {
  const restore = serve()
  try {
    go('/br?collection=elections&office=president&state=12&municipality=1200393&zone=9999')
    await until(() => !search().has('zone'), 'Unknown zone removed')
    await until(settled('ac:01066'), 'Municipality panel')
    assert(
      notices().includes('Zona 9999 não encontrada neste município.'),
      `Zone notice (${notices()})`,
    )
    assert(
      !requests.some((url) => kind(url) === 'results' && url.includes('9999')),
      'No results request for the unknown zone',
    )
    go(
      '/br?collection=elections&office=president&state=12&municipality=1200393&zone=0004&section=9999',
    )
    await until(() => !search().has('section'), 'Unknown section removed')
    await until(settled('ac:01066:0004'), 'Zone panel')
    assert(search().get('zone') === '0004', 'The zone is kept')
    assert(
      notices().includes('Seção 9999 não encontrada na Zona 0004.'),
      `Section notice (${notices()})`,
    )
  } finally {
    restore()
  }
  return 'Invalid codes passed: zone=9999 ignored with notice and no results request, section=9999 ignored keeping the zone'
}

export async function checkExteriorAndRegions() {
  const restore = serve()
  try {
    go('/br?collection=elections&office=president')
    await until(settled('br'), 'Brazil panel')
    await until(
      () => panel().querySelectorAll('[data-national-row] [data-national-coverage]').length === 6,
      'Six national rows',
    )
    await until(
      () =>
        [...panel().querySelectorAll('[data-national-coverage]')].every(
          (node) => node.textContent !== 'Carregando…',
        ),
      'National rows loaded',
    )
    const rows = [...panel().querySelectorAll('[data-national-row]')]
    const names = rows.map((node) => node.textContent)
    for (const name of ['Norte', 'Nordeste', 'Centro-Oeste', 'Sudeste', 'Sul', 'Exterior'])
      assert(
        names.some((value) => value.startsWith(name)),
        `National row ${name}`,
      )
    assert(names[0].includes('soma das UFs (7/7)'), `Region coverage (${names[0]})`)
    assert(names[5].includes('1.351 de 1.351 seções'), `Exterior coverage (${names[5]})`)
    await click('[data-national-row="exterior"]', 'Exterior row')
    await until(settled('exterior'), 'Exterior panel')
    assert(search().get('area') === 'exterior' && !search().has('state'), 'Exterior URL')
    assert(crumbs().join(' > ') === 'Brasil > Exterior', `Exterior breadcrumb (${crumbs()})`)
    await click('[data-depth-item="zz:29262"]', 'Abu Dhabi item')
    await until(settled('zz:29262'), 'Abu Dhabi panel')
    assert(search().get('area') === 'zz:29262', 'Locality URL')
    assert(field('electionResults') === 'unavailable', 'Abu Dhabi has no data')
    assert(title() === 'Abu Dhabi · Localidade no exterior', `Locality title (${title()})`)
    await click('[data-depth-item="zz:29262:0001"]', 'Abu Dhabi zone item')
    await until(settled('zz:29262:0001'), 'Abu Dhabi zone panel')
    assert(
      crumbs().join(' > ') === 'Brasil > Exterior > Abu Dhabi > Zona 0001',
      `Locality zone breadcrumb (${crumbs()})`,
    )
    crumbButton('Exterior').click()
    await until(settled('exterior'), 'Back to the exterior')
    assert(!search().has('zone'), 'The exterior crumb drops the zone')
    go('/br?collection=elections&office=president&area=region:north')
    await until(settled('region:north'), 'Region panel')
    assert(title() === 'Norte · Região', `Region title (${title()})`)
    assert(text().includes('(7/7)'), 'Region coverage in the provenance line')
    await click('[data-depth-item="ac"]', 'Acre in the region')
    await until(settled('ac'), 'Acre panel')
    assert(
      search().get('state') === '12' && !search().has('area'),
      'A state of a region is geographic',
    )
  } finally {
    restore()
  }
  return 'Exterior and regions passed: six national rows with coverage, exterior and locality URLs, unavailable locality, locality zone, breadcrumb ancestors, region panel and its states'
}

export async function checkClearing() {
  const restore = serve()
  try {
    go(SECTION_URL)
    await until(settled('ac:01066:0004:0077'), 'Section panel')
    navigateMap('BR', await mesh('1200401'))
    await until(() => search().get('municipality') === '1200401', 'Other municipality')
    assert(!search().has('zone') && !search().has('section'), 'Changing municipality clears both')
    go('/br?collection=elections&office=president&area=zz:29262')
    await until(settled('zz:29262'), 'Locality panel')
    navigateMap('BR', await mesh('12'))
    await until(() => search().get('state') === '12', 'Geographic choice')
    assert(!search().has('area'), 'A geographic choice removes area')
    go('/br?collection=elections&office=governor&area=exterior')
    await until(() => !search().has('area'), 'Area with governor removed')
    assert(
      notices().some((notice) =>
        notice.startsWith('Exterior e regiões só têm resultados para presidente'),
      ),
      `Office notice (${notices()})`,
    )
    assert(search().get('office') === 'governor', 'The office is kept')
    go('/br?collection=elections&office=president&area=region:moon')
    await until(() => !search().has('area'), 'Unknown region removed')
    assert(
      notices().some((notice) => notice.includes('region:moon')),
      `Unknown area notice (${notices()})`,
    )
  } finally {
    restore()
  }
  return 'Clearing passed: municipality change clears zone and section, geographic choice removes area, area with governor and unknown region ignored with notices'
}

export async function checkMunicipalScopeAtZone() {
  const restore = serve()
  try {
    go('/br?collection=elections&office=council&state=26&municipality=2605459&zone=0004')
    await until(settled('pe:30015:0004'), 'Noronha council at zone 0004')
    await expandSheet()
    const subtitle = panel().querySelector('h2')?.parentElement?.nextElementSibling?.textContent
    assert(
      subtitle === 'Conselho distrital · Fernando de Noronha',
      `Subtitle names the contest's municipality (${subtitle})`,
    )
    const rows = [...panel().querySelectorAll('[data-candidate-row]')].map(
      (node) => node.textContent,
    )
    assert(rows.length > 0, 'Council rows at zone level')
    assert(
      rows.some((row) => row.includes('Eleito · Fernando de Noronha')),
      'Status scoped to the municipality',
    )
    assert(
      rows.every((row) => !row.includes('· Zona 0004') && !row.includes('pe:30015')),
      'No zone name or raw ID in the status badges',
    )
    assert(!text().includes('pe:30015'), 'No raw scope ID in the panel')
  } finally {
    restore()
  }
  return 'Municipal scope at zone passed: subtitle "Conselho distrital · Fernando de Noronha", statuses "Eleito · Fernando de Noronha", no zone name or raw ID in badges'
}

export async function checkZoneListErrorAndPublication() {
  const restore = serve()
  try {
    override = (url) =>
      url.includes('parentId=ac%3A01066') && url.includes('level=zone') && !url.includes('q=')
        ? failure(400, 'LEVEL_TOO_DEEP', 'Level too deep for this scope')
        : null
    go('/br?collection=elections&office=president&state=12&municipality=1200393')
    await until(settled('ac:01066'), 'Municipality panel')
    await until(() => panel().querySelector('[data-depth-error="LEVEL_TOO_DEEP"]'), 'Depth error')
    const error = panel().querySelector('[data-depth-error="LEVEL_TOO_DEEP"]')
    assert(error.textContent.includes('Combinação não disponível'), 'Combination message')
    assert(!error.querySelector('button'), 'No retry for a combination error')
    override = null
    const slots = allRequests.filter((url) => !url.includes('/elections?'))
    assert(slots.length > 0, 'Slot requests were made')
    const publications = new Set(slots.map((url) => new URL(url).searchParams.get('publicationId')))
    assert(
      publications.size === 1 && publications.has(PUBLICATION),
      `One publicationId on every request (${[...publications]})`,
    )
  } finally {
    restore()
  }
  return `Zone list error and publication passed: LEVEL_TOO_DEEP shown without retry, one publicationId on all ${allRequests.length} requests of the run`
}
