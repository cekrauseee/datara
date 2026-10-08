// On the Vite page served with VITE_API_URL pointing at a running API:
// const m = await import('/scripts/check-election-state.mjs')
// for (const check of Object.values(m)) console.log(await check())
import { cached, clear } from '../src/features/elections/api-cache.ts'
import { API_URL, apiRequest, apiURL } from '../src/features/elections/api-client.ts'
import { ELECTION_PARAMETERS } from '../src/features/elections/election-location.ts'
import { navigateElection } from '../src/features/elections/use-election-location.ts'
import { loadCountryMap } from '../src/features/map/map-cache.ts'
import { navigateCountry, navigateMap } from '../src/features/map/use-map-location.ts'

const origin = API_URL.origin
const activeRoot = () => document.querySelector('[data-map-country]:not([hidden])') ?? document
const status = () => activeRoot().querySelector('[data-election-status]')
const field = (name) => status()?.dataset[name]
const search = () => new URL(location.href).searchParams
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// React flushes URL changes in a microtask, so the first evaluation waits a tick.
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
const readyCanvas = () => activeRoot().querySelector('canvas[aria-hidden=false]')
const requestURL = (input) => String(input instanceof Request ? input.url : input)
const isApi = (input) => requestURL(input).startsWith(origin)
function intercept(handler) {
  const original = window.fetch
  window.fetch = (input, init) => handler(original, input, init)
  return () => {
    window.fetch = original
  }
}
async function area(id) {
  const brazil = await loadCountryMap('BR')
  return [...brazil.states, ...brazil.regions].find((feature) => feature.properties.id === id)
    .properties
}
const settledResult = () =>
  ['available', 'unavailable', 'shared'].includes(field('electionResults'))
const retryButton = () =>
  [...(status()?.querySelectorAll('button') ?? [])].find((button) =>
    button.textContent.includes('Tentar novamente'),
  )

export async function checkElectionFlow() {
  go('/br?collection=elections&office=president&state=12&municipality=1200401')
  await until(
    () =>
      field('electionContest') === 'BR-2026-1:6257:1:br' && field('electionArea') === 'ac:01392',
    'Contest and municipal area',
  )
  await until(settledResult, 'Municipal result')
  const publication = field('electionPublication')
  assert(/^[0-9a-f-]{36}$/.test(publication), 'The publication must be pinned')
  assert(
    activeRoot().querySelector('[data-election-office]').value === 'president',
    'The office control must reflect the URL',
  )
  navigateMap('BR', await area('12'))
  await until(
    () => field('electionArea') === 'ac' && field('electionLeader') !== '',
    'State leader',
  )
  assert(status().textContent.includes('%'), 'The leader share must be shown')
  await until(() => field('electionMap') === 'ready', 'Map slot')
  return `Election flow checks passed: contest, area, leader (${field('electionLeader')}) and map on publication ${publication.slice(0, 8)}`
}

export async function checkClearing() {
  const edition = (await apiRequest(apiURL('/elections', { country: 'BR', year: 2026, round: 1 })))
    .items[0].id
  const zone = (
    await apiRequest(
      apiURL(`/elections/${edition}/areas`, { parentId: 'ac:01392', level: 'zone', limit: 1 }),
    )
  ).items[0]
  assert(zone, 'Rio Branco must have a zone in the catalog')
  go(
    `/br?collection=elections&office=president&state=12&municipality=1200401&candidate=280002542548&zone=${zone.zoneCode}`,
  )
  await until(() => field('electionArea') === zone.id, 'Zone area')
  await until(settledResult, 'Zone result')
  assert(
    search().get('zone') === zone.zoneCode && search().get('candidate') === '280002542548',
    'Zone and candidate read',
  )
  navigateElection({ office: 'governor' })
  await until(() => search().get('office') === 'governor', 'Office change')
  assert(!search().has('candidate'), 'Changing the office must clear the candidate')
  assert(search().get('zone') === zone.zoneCode, 'Changing the office keeps the zone')
  navigateMap('BR', await area('1200393'))
  await until(() => search().get('municipality') === '1200393', 'Municipality change')
  assert(
    !search().has('zone') && !search().has('section'),
    'Changing the municipality must clear zone and section',
  )
  assert(search().get('office') === 'governor', 'Geographic navigation preserves the office')
  await until(
    () => field('electionArea')?.startsWith('ac:') && settledResult(),
    'Porto Walter result',
  )
  navigateElection({ office: 'president', area: 'exterior' })
  await until(() => search().get('area') === 'exterior', 'Area parameter')
  assert(
    !search().has('state') && !search().has('municipality'),
    '`area` must remove the IBGE selection',
  )
  await until(() => field('electionArea') === 'exterior' && settledResult(), 'Exterior result')
  navigateMap('BR', await area('12'))
  await until(() => search().get('state') === '12', 'State selection')
  assert(!search().has('area'), 'An IBGE selection must remove `area`')
  history.back()
  await until(
    () => search().get('area') === 'exterior' && field('electionArea') === 'exterior',
    'Back',
  )
  history.forward()
  await until(() => search().get('state') === '12' && field('electionArea') === 'ac', 'Forward')
  return 'Clearing checks passed: office change drops the candidate, municipality change drops zone and section, area and IBGE selection exclude each other, history restores both'
}

export async function checkGeographyOnly() {
  let calls = 0
  const restore = intercept((original, input, init) => {
    if (isApi(input)) calls++
    return original(input, init)
  })
  try {
    go('/br?collection=elections&office=president&state=12')
    await until(() => field('electionArea') === 'ac', 'Brazil election view')
    navigateCountry('US')
    await until(
      () => location.pathname === '/us' && activeRoot().getAttribute('data-map-country') === 'US',
      'US view',
    )
    assert(
      ELECTION_PARAMETERS.every((parameter) => !search().has(parameter)),
      '/us must carry no election parameter',
    )
    assert(!status(), 'The US view has no election status')
    calls = 0
    await wait(800)
    assert(calls === 0, `No API request may leave the US view (${calls})`)
    go('/br?state=35')
    await until(
      () =>
        activeRoot().getAttribute('data-map-country') === 'BR' &&
        activeRoot().querySelector('[aria-current=page]')?.textContent === 'São Paulo',
      'São Paulo without the collection',
    )
    await wait(800)
    assert(
      location.pathname + location.search === '/br?state=35',
      'The geography-only URL must stay identical',
    )
    assert(calls === 0, `No API request may leave the page without the collection (${calls})`)
    assert(!status(), 'No election status without the collection')
    assert(
      activeRoot().querySelector('[data-election-collection]').value === '',
      'The collection control shows Geografia',
    )
    assert(
      !activeRoot().querySelector('[data-election-office]'),
      'No office control without the collection',
    )
  } finally {
    restore()
  }
  return 'Geography-only checks passed: /us strips the election parameters; /us and /br?state=35 make no API request'
}

export async function checkPublicationPinning() {
  const requests = []
  const restore = intercept((original, input, init) => {
    if (isApi(input)) requests.push(requestURL(input))
    return original(input, init)
  })
  try {
    clear()
    go('/br?collection=elections&office=president&state=12')
    await until(
      () => field('electionArea') === 'ac' && settledResult() && field('electionMap') === 'ready',
      'President in Acre',
    )
    for (const [office, code] of [
      ['governor', '3'],
      ['senator', '5'],
    ]) {
      navigateElection({ office })
      await until(
        () =>
          field('electionContest').endsWith(`:${code}:ac`) &&
          settledResult() &&
          field('electionMap') === 'ready',
        office,
      )
    }
    navigateMap('BR', await area('1200393'))
    await until(
      () => /^ac:\d{5}$/.test(field('electionArea') ?? '') && settledResult(),
      'Porto Walter',
    )
    const publication = field('electionPublication')
    const slots = requests.filter((url) => !url.includes('/elections?'))
    assert(slots.length >= 4, `Slot requests expected (${slots.length})`)
    const wrong = slots.filter(
      (url) => new URL(url).searchParams.get('publicationId') !== publication,
    )
    assert(
      wrong.length === 0,
      `Every request must carry the pinned publication: ${wrong.join(', ')}`,
    )
    const kinds = new Set(slots.map((url) => new URL(url).pathname.split('/').at(-1)))
    assert(
      ['results', 'map', 'areas'].every((kind) => kinds.has(kind)),
      `Results, map and areas expected (${[...kinds]})`,
    )
  } finally {
    restore()
  }
  return 'Publication pinning checks passed: one publicationId on every slot request'
}

export async function checkPublicationAndRound() {
  const bogus = '00000000-0000-4000-8000-000000000000'
  go(`/br?collection=elections&office=president&publication=${bogus}`)
  await until(
    () => field('electionStatus') === 'ready' && settledResult(),
    'Fallback to the active publication',
  )
  const publication = field('electionPublication')
  assert(
    publication.length === 36 && publication !== bogus,
    'An unknown publication falls back to the active one',
  )
  assert(search().get('publication') === bogus, 'The publication parameter is kept')
  assert(status().textContent.includes('não existe'), 'The fallback must be announced')
  const calls = []
  const restore = intercept((original, input, init) => {
    if (isApi(input)) calls.push(requestURL(input))
    return original(input, init)
  })
  try {
    go('/br?collection=elections&office=president&round=2')
    await until(
      () => field('electionStatus') === 'ready' && status().textContent.includes('2º turno'),
      'Second round notice',
    )
    await wait(500)
  } finally {
    restore()
  }
  assert(
    calls.every((url) => url.includes('/elections?')),
    `No slot request without an edition: ${calls}`,
  )
  assert(
    field('electionPublication') === '' && field('electionContest') === '',
    'Nothing resolves without an edition',
  )
  return 'Publication and round checks passed: unknown publication announced and kept, missing round announced without slot requests'
}

export async function checkStaleness() {
  clear()
  go('/br?collection=elections&office=president&state=12')
  await until(() => field('electionArea') === 'ac' && settledResult(), 'President in Acre')
  const restore = intercept(async (original, input, init) => {
    if (isApi(input) && /:3:ac\/results/.test(requestURL(input))) await wait(1500)
    return original(input, init)
  })
  try {
    navigateElection({ office: 'governor' })
    await until(() => field('electionContest').endsWith(':3:ac'), 'Governor contest')
    await wait(100)
    navigateElection({ office: 'senator' })
    await until(
      () => field('electionContest').endsWith(':5:ac') && settledResult(),
      'Senator result',
    )
    const contest = field('electionContest')
    const leader = field('electionLeader')
    assert(leader, 'A senator leader is expected')
    await wait(1800)
    assert(
      field('electionContest') === contest && field('electionLeader') === leader,
      'A late governor response must not overwrite the senator status',
    )
  } finally {
    restore()
  }
  return 'Staleness checks passed: a delayed response for a previous office never reaches the status'
}

export async function checkApiDown() {
  clear()
  go('/br?collection=elections&office=senator&state=12')
  await until(
    () => field('electionContest').endsWith(':5:ac') && settledResult(),
    'Senator in Acre',
  )
  const restore = intercept((original, input, init) =>
    isApi(input) ? Promise.reject(new TypeError('Failed to fetch')) : original(input, init),
  )
  try {
    navigateElection({ office: 'president' })
    await until(() => field('electionStatus') === 'error' && retryButton(), 'Error with retry')
    assert(
      status().querySelector('[data-election-error]').dataset.electionError === 'NETWORK_ERROR',
      'The network failure must be mapped',
    )
    await until(() => readyCanvas()?.__zoom, 'Ready canvas', 20_000)
    const canvas = readyCanvas()
    const before = canvas.__zoom.k
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }))
    await wait(400)
    assert(canvas.__zoom.k > before, 'The map must keep zooming while the API is down')
    navigateMap('BR', await area('3550308'))
    await until(
      () => activeRoot().querySelector('[aria-current=page]')?.textContent === 'São Paulo',
      'Selection while down',
    )
    assert(
      search().get('office') === 'president' && search().get('municipality') === '3550308',
      'URL keeps working',
    )
    await until(() => field('electionStatus') === 'error', 'Error persists')
  } finally {
    restore()
  }
  retryButton().click()
  await until(
    () => field('electionStatus') !== 'error' && settledResult(),
    'Recovery after retry',
    15_000,
  )
  assert(
    field('electionArea').startsWith('sp:'),
    `São Paulo must resolve after the retry (${field('electionArea')})`,
  )
  return 'API-down checks passed: mapped error with retry, map and selection alive, recovery after retry'
}

export async function checkApiCache() {
  const url = apiURL('/elections', { country: 'BR', year: 2026, round: 1 })
  clear()
  const first = cached(url, () => apiRequest(url))
  const concurrent = cached(url, () => apiRequest(url))
  assert(first === concurrent, 'Concurrent requests must share the same promise')
  const value = await first
  assert(
    cached(url, () => apiRequest(url)) === first && value.items.length >= 1,
    'Settled requests must be reused',
  )
  const missing = apiURL('/elections/nope')
  let previous
  for (let i = 0; i < 2; i++) {
    const request = cached(missing, () => apiRequest(missing))
    assert(request !== previous, 'Failed entries must be evicted so a retry is possible')
    previous = request
    let failed = false
    try {
      await request
    } catch (error) {
      failed = error.status === 404 && error.code === 'ELECTION_NOT_FOUND' && !!error.requestId
    }
    assert(failed, 'A failed request must reject with the mapped API error')
  }
  return 'API cache checks passed: shared promises, settled reuse and failure eviction'
}
