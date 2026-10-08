// On the Vite page (any VITE_API_URL: requests to that origin are answered with the fixtures
// derived from the pilot publication under scripts/fixtures/election-panel):
// const m = await import('/scripts/check-election-panel.mjs')
// for (const check of Object.values(m)) console.log(await check())
// Run it twice: at desktop width and with device emulation below 640px (the sheet assertions
// only run at that width).
import { clear } from '../src/features/elections/api-cache.ts'
import { API_URL } from '../src/features/elections/api-client.ts'
import { navigateElection } from '../src/features/elections/use-election-location.ts'
import { loadCountryMap } from '../src/features/map/map-cache.ts'
import { navigateCountry, navigateMap } from '../src/features/map/use-map-location.ts'

const origin = API_URL.origin
const FIXTURES = '/scripts/fixtures/election-panel'
const PUBLICATION = '2a4cee03-930c-4377-b383-fcb27f9da55d'
const EDITION = 'BR-2026-1'
const PRESIDENT = `${EDITION}:6257:1:br`
const RESULTS = {
  [`${PRESIDENT}|br|0`]: 'results-president-br',
  [`${PRESIDENT}|ac|0`]: 'results-president-ac',
  [`${PRESIDENT}|df|0`]: 'results-president-df',
  [`${PRESIDENT}|ac:01392|0`]: 'results-president-rio-branco',
  [`${EDITION}:6259:3:ac|ac|0`]: 'results-governor-ac',
  [`${EDITION}:6259:5:ac|ac|0`]: 'results-senator-ac',
  [`${EDITION}:6259:6:ac|ac|0`]: 'results-federal-deputy-ac',
  [`${EDITION}:6259:6:ac|ac|25`]: 'results-federal-deputy-ac-25',
  [`${EDITION}:6261:25:pe:30015|pe:30015|0`]: 'results-council-noronha',
}

const realFetch = window.fetch.bind(window)
const activeRoot = () => document.querySelector('[data-map-country]:not([hidden])') ?? document
const panel = () => activeRoot().querySelector('[data-election-status]')
const field = (name) => panel()?.dataset[name]
const search = () => new URL(location.href).searchParams
const text = () => panel()?.textContent ?? ''
const rows = () => panel()?.querySelectorAll('[data-candidate-row]').length ?? 0
const shares = () =>
  [...(panel()?.querySelectorAll('[data-candidate-share]') ?? [])].map((node) => node.textContent)
const items = () => panel()?.querySelectorAll('[data-area-item]') ?? []
const button = (label) =>
  [...(panel()?.querySelectorAll('button') ?? [])].find((node) => node.textContent.includes(label))
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
  throw new Error(`${label} did not settle`)
}
function go(path) {
  history.pushState(null, '', path)
  dispatchEvent(new Event('map:navigate'))
}
async function area(id) {
  const brazil = await loadCountryMap('BR')
  return [...brazil.states, ...brazil.regions].find((feature) => feature.properties.id === id)
    .properties
}
const readyCanvas = () => activeRoot().querySelector('canvas[aria-hidden=false]')
const available = () => field('electionResults') === 'available'
const requestURL = (input) => String(input instanceof Request ? input.url : input)
// Below `sm` the panel is a collapsed sheet whose content is inert: expand it before acting on it.
async function expandSheet() {
  if (panel()?.dataset.mobileSheet !== 'collapsed') return
  panel().querySelector('button[aria-expanded]').click()
  await until(() => panel()?.dataset.mobileSheet === 'expanded', 'Expanded sheet')
}

// Fixture server: every API request is answered from the fixtures; `override` lets a scenario
// delay, fail or replace single responses.
const fixtures = new Map()
async function fixture(name) {
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
    headers: { 'content-type': 'application/json', 'x-request-id': `fixture-${status}` },
  })
const failure = (status, code, message) =>
  json({ error: { code, message, requestId: `fixture-${code}` } }, status)
const emptyList = () =>
  fixture('elections').then((list) => ({
    publicationId: PUBLICATION,
    coverage: list.items[0].publication.coverage,
    items: [],
    pagination: { limit: 25, offset: 0, total: 0, hasMore: false },
  }))

async function route(url) {
  const { pathname, searchParams: query } = new URL(url)
  if (pathname === '/elections')
    return query.get('round') === '2'
      ? json({ items: [], pagination: { limit: 25, offset: 0, total: 0, hasMore: false } })
      : json(await fixture('elections'))
  if (pathname === `/elections/${EDITION}/contests`) return json(await fixture('contests'))
  if (pathname === `/elections/${EDITION}/areas`) {
    const areas = await fixture('areas')
    return json(areas[query.get('featureId')] ?? (await emptyList()))
  }
  if (pathname === `/elections/${EDITION}/map`) {
    if (
      query.get('officeCode') === '3' &&
      query.get('level') === 'state' &&
      query.get('metric') === 'leader'
    )
      return json(await fixture('map-office-governor-state'))
    return failure(404, 'FIXTURE_NOT_FOUND', `No fixture for ${url}`)
  }
  const results = pathname.match(/^\/contests\/(.+)\/results$/)
  if (results) {
    const key = `${decodeURIComponent(results[1])}|${query.get('areaId')}|${query.get('offset') ?? '0'}`
    const name = RESULTS[key]
    return name
      ? json(await fixture(name))
      : failure(404, 'FIXTURE_NOT_FOUND', `No results fixture for ${key}`)
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
let override = null
function serve() {
  const previous = window.fetch
  requests = []
  override = null
  clear()
  window.fetch = async (input, init) => {
    const url = requestURL(input)
    if (!url.startsWith(origin)) return previous(input, init)
    requests.push(url)
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
const slotRequests = () => requests.filter((url) => !url.includes('/elections?'))
const kind = (url) => new URL(url).pathname.split('/').at(-1)

export async function checkPanelGeographyOnly() {
  const restore = serve()
  try {
    go('/br?state=12')
    await until(
      () => activeRoot().querySelector('[aria-current=page]')?.textContent === 'Acre',
      'Acre selected',
    )
    requests = []
    await wait(800)
    assert(requests.length === 0, `No API request without the collection (${requests.length})`)
    assert(!panel(), 'No results panel without the collection')
    const control = activeRoot().querySelector('[data-election-collection]')
    assert(control?.dataset.electionCollection === '', 'The collection control shows Geografia')
    assert(!activeRoot().querySelector('[data-election-office]'), 'No office control')
    go('/br?collection=elections&state=12')
    await until(
      () => activeRoot().querySelector('[data-election-office]')?.dataset.electionOffice === '',
      'Office control without an office',
    )
    await until(() => requests.some((url) => kind(url) === 'contests'), 'Contests loaded')
    await wait(800)
    assert(!panel(), 'No results panel without an office')
    assert(
      activeRoot().querySelector('[data-results-panel="card"]'),
      'The geographic card stays without an office',
    )
    assert(
      requests.every((url) => !['results', 'map'].includes(kind(url))),
      `No results or map request without an office: ${requests.join(', ')}`,
    )
  } finally {
    restore()
  }
  return 'Geography-only checks passed: no request without the collection, no results or map request without an office, geographic card kept'
}

export async function checkPresidentSummary() {
  const restore = serve()
  try {
    go('/br?collection=elections&office=president')
    await until(() => field('electionArea') === 'br' && available(), 'President in Brazil')
    assert(
      panel().querySelector('[data-candidate-list]')?.dataset.candidateList === 'summary',
      'President uses the summary mode',
    )
    assert(rows() === 2, `Two summary rows expected (${rows()})`)
    assert(shares()[0] === '47,0%' && shares()[1] === '45,2%', `Shares ${shares()}`)
    assert(text().includes('Vantagem 1,9 p.p. · 2.224.965 votos'), 'Margin line')
    assert(!panel().querySelector('[data-seat-cutoff]'), 'No seat cutoff for the presidency')
    assert(text().includes('Mais votado aqui') && text().includes('2º turno · Brasil'), 'Badges')
    assert(text().includes('Outros 10 candidatos somam 7,8%'), 'Share of the others')
    assert(
      panel().querySelector('[data-coverage]')?.textContent.includes('499.248 de 499.248 seções'),
      'Coverage line with sections',
    )
    assert(text().includes('totalização oficial'), 'Source kind label')
    assert(
      panel().querySelectorAll('[data-total-missing]').length >= 2,
      'Null totals render as a dash',
    )
    assert(items().length === 27, `27 states in the navigation list (${items().length})`)
    await until(
      () =>
        items()[0]?.textContent.includes('Flavio Bolsonaro (PL)') &&
        items()[0].textContent.includes('35,8 p.p.'),
      'Acre leader and margin from the state map',
    )
    const expand = button('Ver todos os 12')
    assert(expand && expand.getAttribute('aria-expanded') === 'false', 'Expand button')
    expand.click()
    await until(() => rows() === 12, 'Full first page')
    assert(expand.getAttribute('aria-expanded') === 'true', 'aria-expanded after expanding')
    assert(!button('Carregar mais'), 'No further page for 12 candidates')
    const wrong = slotRequests().filter(
      (url) => new URL(url).searchParams.get('publicationId') !== PUBLICATION,
    )
    assert(wrong.length === 0, `Every request carries the pinned publication: ${wrong}`)
    await expandSheet()
    panel().querySelector('[data-area-item="12"]').click()
    await until(
      () => search().get('state') === '12' && field('electionArea') === 'ac' && available(),
      'Acre through the list',
    )
    await until(
      () => document.activeElement?.tagName === 'H2' && panel().contains(document.activeElement),
      'Title focused after the navigation',
    )
    assert(shares()[0] === '64,6%' && shares()[1] === '28,7%', `Acre shares ${shares()}`)
    assert(text().includes('Vantagem 35,8 p.p.'), 'Acre margin')
    assert(items().length === 22, `22 municipalities of Acre (${items().length})`)
    const portoWalter = () => panel().querySelector('[data-area-item="1200393"]')
    await until(
      () =>
        portoWalter()?.textContent.includes('Lula (PT)') &&
        portoWalter().textContent.includes('6,8 p.p.'),
      'Porto Walter leader from the municipal map',
    )
    assert(
      panel().querySelector('[data-area-item="1200401"]')?.textContent.includes('sem dados'),
      'Rio Branco without data in the list',
    )
    assert(activeRoot().querySelectorAll('[data-election-status]').length === 1, 'One panel')
  } finally {
    restore()
  }
  return 'President summary checks passed: two rows, margin, badges, others, coverage, dashes, 27 states, expansion, pinned publication, list navigation with focus and 22 municipalities'
}

export async function checkSenatorAndGovernor() {
  const restore = serve()
  try {
    go('/br?collection=elections&office=senator&state=12')
    await until(() => field('electionContest')?.endsWith(':5:ac') && available(), 'Senator')
    assert(rows() === 3, `Three summary rows for the Senate (${rows()})`)
    const cutoff = panel().querySelector('[data-seat-cutoff]')
    assert(
      cutoff?.textContent.includes('1,4 p.p.') && cutoff.textContent.includes('11.860'),
      'Seat cutoff of the second seat',
    )
    assert(text().includes('Vantagem 7,6 p.p.'), 'Senate margin')
    assert(text().includes('Anulado sub judice'), 'Vote destination badge')
    assert(text().includes('Eleito · Acre'), 'Official status with scope')
    assert(text().includes('dois nomes'), 'Senate note in the totals')
    navigateElection({ office: 'governor' })
    await until(() => field('electionContest')?.endsWith(':3:ac') && available(), 'Governor')
    assert(rows() === 2, `Two rows for the governor (${rows()})`)
    assert(shares()[0] === '49,8%', `Governor share ${shares()}`)
    assert(text().includes('2º turno · Acre'), 'Governor status with the state scope')
    assert(!panel().querySelector('[data-seat-cutoff]'), 'Cutoff only in the Senate')
  } finally {
    restore()
  }
  return 'Senate and governor checks passed: three rows with the seat cutoff, destination and status badges, two rows for the governor'
}

export async function checkRanking() {
  const restore = serve()
  try {
    go('/br?collection=elections&office=federal-deputy&state=12')
    await until(() => field('electionContest')?.endsWith(':6:ac') && available(), 'Deputies')
    assert(
      panel().querySelector('[data-candidate-list]')?.dataset.candidateList === 'ranking',
      'Deputies use the ranking mode',
    )
    assert(rows() === 25, `First page of 25 (${rows()})`)
    const first = panel().querySelector('[data-candidate-row]')
    assert(first.textContent.startsWith('1.') || first.textContent.includes('1. '), 'Positions')
    assert(text().includes('Eleito por QP · Acre'), 'Proportional status with scope')
    assert(text().includes('oficial TSE'), 'Official percentage when it differs')
    const parties = panel().querySelector('[data-party-totals]')
    assert(parties, 'Party totals block')
    assert(parties.querySelectorAll('tbody tr').length === 20, 'Twenty parties')
    assert(parties.textContent.includes('PP'), 'Party label resolved from the rows')
    assert(text().includes('Vagas não são inferidas'), 'Fixed note')
    assert(
      requests.every((url) => kind(url) !== 'map'),
      `No map request for a proportional office: ${requests.filter((url) => kind(url) === 'map')}`,
    )
    const more = panel().querySelector('[data-load-more]')
    assert(more, 'Load more button')
    more.click()
    await until(() => rows() === 50, 'Second page')
    assert(
      [...panel().querySelectorAll('[data-candidate-row]')].at(-1).textContent.includes('50.'),
      'Position of the fiftieth row',
    )
    assert(items().length === 22, 'Municipalities listed by name for deputies')
    assert(
      ![...items()].some((item) => item.textContent.includes('p.p.')),
      'No margins without a leader map',
    )
  } finally {
    restore()
  }
  return 'Ranking checks passed: 25 positions, status with scope, party totals, no map request, second page by offset'
}

export async function checkNationalGovernor() {
  const restore = serve()
  try {
    go('/br?collection=elections&office=governor')
    await until(
      () => panel()?.querySelector('[data-national-view="3"]') && items().length === 27,
      'National governor view',
    )
    const alagoas = () => panel().querySelector('[data-area-item="27"]')
    await until(
      () => alagoas()?.textContent.includes('JHC') && alagoas().textContent.includes('4,8 p.p.'),
      'Alagoas leader and margin from the office map',
    )
    assert(field('electionContest') === '', 'No single contest nationally')
    await wait(300)
    assert(
      requests.every((url) => kind(url) !== 'results'),
      'No /results request nationally',
    )
    assert(
      requests.some((url) => new URL(url).pathname === `/elections/${EDITION}/map`),
      'Office map requested',
    )
    assert(text().includes('Selecione um estado'), 'Instruction text')
  } finally {
    restore()
  }
  return 'National governor checks passed: 27 states with leaders from the office map, no results request'
}

export async function checkEmptyAndErrors() {
  const restore = serve()
  let note = ''
  try {
    go('/br?collection=elections&office=president&state=12&municipality=1200401')
    await until(() => field('electionResults') === 'unavailable', 'Rio Branco unavailable')
    const empty = panel().querySelector('[data-panel-empty]')
    assert(
      empty?.textContent.includes('Sem resultados para Rio Branco') &&
        empty.textContent.includes('Ausência de dado não é zero'),
      'Empty state text',
    )
    override = (url) =>
      new URL(url).pathname.endsWith('/results')
        ? failure(503, 'DATABASE_UNAVAILABLE', 'database unavailable')
        : null
    navigateMap('BR', await area('12'))
    await until(
      () =>
        field('electionStatus') === 'error' &&
        panel().querySelector('[data-election-error="DATABASE_UNAVAILABLE"]'),
      'Error 503',
    )
    assert(text().includes('Banco indisponível'), 'Message for 503')
    assert(
      activeRoot().querySelector('[aria-current=page]')?.textContent === 'Acre',
      'The breadcrumb keeps following the selection while the panel shows an error',
    )
    // A hidden page stops animation frames, so the map cannot draw or zoom there: the canvas
    // steps only run on a visible page.
    if (document.visibilityState === 'visible') {
      await until(() => readyCanvas()?.__zoom, 'Ready canvas', 20_000)
      await wait(600)
      const canvas = readyCanvas()
      assert(canvas.tabIndex === 0, 'The canvas stays interactive')
      assert(
        !activeRoot().querySelector('[aria-label="Aproximar mapa"]')?.disabled,
        'Zoom controls stay enabled',
      )
      const before = canvas.__zoom.k
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }))
      await until(() => canvas.__zoom.k > before, 'Zoom while the panel shows an error', 2000)
    } else note = ' (canvas steps skipped: the page is hidden)'
    override = (url) =>
      new URL(url).pathname.endsWith('/results')
        ? Promise.reject(new TypeError('Failed to fetch'))
        : null
    button('Tentar novamente').click()
    await until(
      () => panel().querySelector('[data-election-error="NETWORK_ERROR"]'),
      'Network failure',
    )
    assert(text().includes('Não foi possível contatar'), 'Message for the network failure')
    override = null
    button('Tentar novamente').click()
    await until(() => available() && field('electionArea') === 'ac', 'Recovery')
    assert(shares()[0] === '64,6%', `Acre shares after the retry (${shares()})`)
  } finally {
    restore()
  }
  return `Empty and error checks passed: unavailable area, 503 and network failure with retry while the map, the selection and the controls keep working${note}`
}

export async function checkStaleness() {
  const restore = serve()
  try {
    go('/br?collection=elections&office=president')
    await until(() => field('electionArea') === 'br' && available(), 'President in Brazil')
    override = async (url) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/results') && parsed.searchParams.get('areaId') === 'ac')
        await wait(1500)
      return null
    }
    navigateMap('BR', await area('12'))
    await until(() => field('electionArea') === 'ac', 'Acre area')
    assert(
      field('electionResults') === 'loading' && panel().querySelector('[aria-busy="true"]'),
      'Previous content kept with aria-busy while Acre loads',
    )
    await wait(100)
    navigateMap('BR', await area('53'))
    await until(() => field('electionArea') === 'df' && available(), 'Federal District')
    assert(panel().querySelector('[data-contest-body="df"]'), 'Federal District body')
    await wait(1800)
    assert(
      field('electionArea') === 'df' &&
        panel().querySelector('[data-contest-body="df"]') &&
        field('electionLeader') === 'FLAVIO BOLSONARO (PL)',
      'The late Acre response must not overwrite the Federal District',
    )
  } finally {
    restore()
  }
  return 'Staleness checks passed: a delayed response for a previous area never reaches the panel'
}

export async function checkOfficeCleared() {
  const restore = serve()
  try {
    go('/br?collection=elections&office=council&state=26&municipality=2605459')
    await until(
      () => field('electionContest')?.endsWith(':25:pe:30015') && available(),
      'Noronha council',
    )
    assert(
      panel().querySelector('[data-candidate-list]')?.dataset.candidateList === 'ranking',
      'The council uses the ranking mode',
    )
    assert(rows() === 22, `22 council candidates (${rows()})`)
    assert(!panel().querySelector('[data-party-totals]'), 'No party block for the council')
    assert(!text().includes('nº 789 ·'), 'No party label for council candidates')
    navigateMap('BR', await area('26'))
    await until(
      () => search().get('state') === '26' && !search().has('office'),
      'Office cleared for the state',
    )
    assert(search().get('collection') === 'elections', 'The collection stays open')
    await until(
      () =>
        activeRoot()
          .querySelector('[data-election-warnings]')
          ?.textContent.includes('Sem disputa de Conselho distrital em Pernambuco'),
      'Notice of the cleared office',
    )
    assert(
      activeRoot().querySelector('[data-election-office]')?.dataset.electionOffice === '',
      'Office control visible and empty',
    )
  } finally {
    restore()
  }
  return 'Office clearing checks passed: council ranking without parties, office removed for the state with a notice'
}

export async function checkUsWithoutPanel() {
  const restore = serve()
  try {
    go('/br?collection=elections&office=president&state=12')
    await until(() => field('electionArea') === 'ac' && available(), 'Acre')
    navigateCountry('US')
    await until(
      () => location.pathname === '/us' && activeRoot().getAttribute('data-map-country') === 'US',
      'US view',
    )
    assert(!panel(), 'No panel in the US view')
    assert(!activeRoot().querySelector('[data-election-collection]'), 'No selector in the US view')
    navigateCountry('BR')
    await until(() => location.pathname === '/br', 'Back to Brazil')
  } finally {
    restore()
  }
  return 'US checks passed: no panel and no collection selector outside Brazil'
}

export async function checkPanelLayout() {
  const mobile = matchMedia('(max-width: 39.99rem)').matches
  const restore = serve()
  try {
    go('/br?collection=elections&office=president&state=12')
    await until(() => field('electionArea') === 'ac' && available(), 'Acre')
    const main = activeRoot().querySelector('main')
    const inset = getComputedStyle(main).getPropertyValue('--panel-inset').trim()
    const bottom = getComputedStyle(main).getPropertyValue('--panel-inset-bottom').trim()
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id)
    assert(new Set(ids).size === ids.length, 'No duplicate element IDs with the panel')
    if (!mobile) {
      assert(panel().dataset.resultsPanel === 'column', 'Desktop column')
      assert(bottom === '0px', `--panel-inset-bottom is 0 on desktop (${bottom})`)
      assert(
        inset === '20.75rem' || inset === '22.75rem',
        `--panel-inset is the column width (${inset})`,
      )
      const body = panel().firstElementChild
      assert(
        getComputedStyle(body).overflowY === 'auto',
        'The column body scrolls instead of growing',
      )
      return 'Desktop layout checks passed: column, --panel-inset set, scrolling body, unique IDs'
    }
    const sheet = panel()
    const toggle = sheet.querySelector('button[aria-expanded]')
    const content = document.getElementById(toggle.getAttribute('aria-controls'))
    // An earlier check may have left the sheet open; the state is local to the panel.
    if (sheet.dataset.mobileSheet === 'expanded') {
      toggle.click()
      await until(() => sheet.dataset.mobileSheet === 'collapsed', 'Collapsed sheet')
      await wait(400)
    }
    assert(sheet.dataset.mobileSheet === 'collapsed', 'Sheet collapsed')
    assert(bottom === '3.5rem', `--panel-inset-bottom is the collapsed sheet height (${bottom})`)
    assert(inset === '0px', `--panel-inset is 0 on mobile (${inset})`)
    assert(toggle.getAttribute('aria-expanded') === 'false' && content.inert, 'Collapsed content')
    assert(
      content.getBoundingClientRect().height < 1,
      `The collapsed content takes no height (${content.getBoundingClientRect().height}px)`,
    )
    assert(
      toggle.textContent.includes('Flavio Bolsonaro') && toggle.textContent.includes('64,6%'),
      'Collapsed summary with leader and share',
    )
    toggle.click()
    await until(() => sheet.dataset.mobileSheet === 'expanded', 'Expanded sheet')
    assert(toggle.getAttribute('aria-expanded') === 'true' && !content.inert, 'Expanded content')
    assert(rows() === 2 && items().length === 22, 'Content inside the sheet')
    toggle.click()
    await until(() => sheet.dataset.mobileSheet === 'collapsed', 'Collapsed again')
    return 'Mobile layout checks passed: sheet collapsed and expanded, --panel-inset-bottom set, unique IDs'
  } finally {
    restore()
  }
}
