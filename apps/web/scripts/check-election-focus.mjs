// Browser check of the candidate focus against the API of VITE_API_URL with the pilot publication.
// On the Vite page:
// const m = await import('/scripts/check-election-focus.mjs')
// for (const check of Object.values(m)) console.log(await check())
// `fetch` is wrapped to record API requests (one publicationId) and the canvas `fill` to record
// the layer colours; neither changes a response.
import { cachedKeys } from '../src/features/elections/api-cache.ts'
import { API_URL } from '../src/features/elections/api-client.ts'
import { navigateElection } from '../src/features/elections/use-election-location.ts'

const LULA = '280002542548'
const FLAVIO = '280002551544'
const MAILZA = '10002544107'
const PRESIDENT = 'BR-2026-1:6257:1:br'
const LULA_ID = `${PRESIDENT}:${LULA}`
const LULA_COLOR = '#ee2d35'
const PORTO_WALTER = '/br?collection=elections&office=president&municipality=1200393'

const realFetch = window.fetch.bind(window)
const activeRoot = () => document.querySelector('[data-map-country]:not([hidden])') ?? document
const panel = () => activeRoot().querySelector('[data-election-status]')
const card = () => panel()?.querySelector('[data-candidate-card]') ?? null
const legend = () => activeRoot().querySelector('[data-map-legend]')
const search = () => new URL(location.href).searchParams
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, label = 'Condition', timeout = 15_000) {
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
const settled = () => panel()?.dataset.electionStatus === 'ready'
const button = (root, label) =>
  [...(root?.querySelectorAll('button') ?? [])].find((node) => node.textContent.trim() === label)
const pressed = (id) =>
  panel()?.querySelector(`[data-candidate-row="${PRESIDENT}:${id}"] button`)?.ariaPressed
async function expandSheet() {
  if (panel()?.dataset.mobileSheet !== 'collapsed') return
  panel().querySelector('button[aria-expanded]').click()
  await until(() => panel()?.dataset.mobileSheet === 'expanded', 'Expanded sheet')
}
// Below `sm` the legend starts collapsed into a button.
const legendTitle = () => {
  const collapsed = legend()?.querySelector('button[aria-expanded=false]')
  if (collapsed) collapsed.click()
  return legend()?.querySelector('[data-map-legend-title]')?.textContent ?? ''
}
async function api(path) {
  const publicationId = panel()?.dataset.electionPublication
  const url = new URL(path, API_URL)
  url.searchParams.set('publicationId', publicationId)
  return (await realFetch(url)).json()
}
const close = (a, b, label) =>
  assert(Math.abs(Number(a) - Number(b)) < 1e-9, `${label}: ${a} ≠ ${b}`)

function recordRequests() {
  const requests = []
  window.fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith(API_URL.origin)) requests.push(url)
    return realFetch(input, init)
  }
  return {
    requests,
    restore() {
      window.fetch = realFetch
    },
  }
}

function recordFills() {
  const fills = []
  const proto = CanvasRenderingContext2D.prototype
  const fill = proto.fill
  proto.fill = function (...args) {
    fills.push([this.fillStyle, this.globalAlpha])
    return fill.apply(this, args)
  }
  return {
    fills,
    restore() {
      proto.fill = fill
    },
  }
}

export async function checkFocusRoundTrip() {
  const record = recordRequests()
  try {
    go(`/br?collection=elections&office=president&candidate=${LULA}`)
    await until(() => card()?.dataset.candidateCard === LULA && settled(), 'Card of Lula')
    await expandSheet()
    assert(card().querySelector('[data-candidate-card-name]').textContent === 'Lula', 'Card name')
    assert(pressed(LULA) === 'true' && pressed(FLAVIO) === 'false', 'Row aria-pressed')
    assert(!search().has('metric'), 'Support is the default metric')
    assert(
      card().querySelector('[data-focus-contribution="100"]'),
      'Brazil is the contest scope: contribution 100%',
    )
    await until(() => legend()?.dataset.mapLegend === 'ready', 'Legend ready')
    const toggle = card().querySelector('[aria-label="Métrica"]')
    button(toggle, 'Votos').click()
    await until(() => search().get('metric') === 'votes', 'metric=votes')
    await until(() => legendTitle().startsWith('Votos de Lula'), 'Votes legend')
    button(card().querySelector('[aria-label="Métrica"]'), 'Contribuição').click()
    await until(() => search().get('metric') === 'contribution', 'metric=contribution')
    button(card().querySelector('[aria-label="Métrica"]'), 'Apoio').click()
    await until(() => !search().has('metric') && search().get('candidate') === LULA, 'Support')
    await until(() => legendTitle() === 'Apoio a Lula (13 · PT)', 'Support legend')
    // Exit by the card, then by the row (pressed again).
    button(card(), 'Sair do foco').click()
    await until(() => !card() && !search().has('candidate') && !search().has('metric'), 'Exit')
    panel().querySelector(`[data-candidate-row="${PRESIDENT}:${FLAVIO}"] button`).click()
    await until(() => card()?.dataset.candidateCard === FLAVIO, 'Focus on Flávio by click')
    assert(!search().has('metric'), 'Entering writes no metric')
    panel().querySelector(`[data-candidate-row="${PRESIDENT}:${FLAVIO}"] button`).click()
    await until(() => !card() && !search().has('candidate'), 'Exit by the pressed row')
    // Office change ends the focus; history restores it.
    go(`/br?collection=elections&office=president&candidate=${LULA}&metric=votes`)
    await until(() => card()?.dataset.candidateCard === LULA, 'Focus with votes')
    navigateElection({ office: 'governor' })
    await until(() => !search().has('candidate') && !search().has('metric'), 'Office change')
    assert(search().get('office') === 'governor', 'Governor selected')
    history.back()
    await until(
      () =>
        search().get('candidate') === LULA &&
        search().get('metric') === 'votes' &&
        card()?.dataset.candidateCard === LULA,
      'History restores the focus',
    )
    const publications = new Set(
      record.requests.map((url) => new URL(url).searchParams.get('publicationId')).filter(Boolean),
    )
    assert(publications.size === 1, `One publicationId (${[...publications].join(', ')})`)
    return `Focus round trip passed: card, aria-pressed, metric tokens, exit, office change, history, ${record.requests.length} requests on one publication`
  } finally {
    record.restore()
  }
}

export async function checkFocusMap() {
  go(`/br?collection=elections&office=president&level=state&candidate=${LULA}`)
  await until(() => card()?.dataset.candidateCard === LULA && settled(), 'Card')
  await until(() => legend()?.dataset.mapLegend === 'ready', 'Legend ready')
  const record = recordFills()
  try {
    // A grain round trip repaints the support layer at state grain.
    navigateElection({ level: 'municipality' })
    await until(() => !search().has('level'), 'Municipal grain')
    navigateElection({ level: 'state' })
    await until(() => search().get('level') === 'state', 'State grain')
    await until(() => legend()?.dataset.mapLegend === 'ready', 'Legend ready again')
    await until(
      () => record.fills.some(([color]) => color === LULA_COLOR),
      'Candidate fills',
      20_000,
    )
    await wait(300)
  } finally {
    record.restore()
  }
  const alphas = new Set(
    record.fills.filter(([color]) => color === LULA_COLOR).map(([, alpha]) => alpha),
  )
  assert(alphas.size >= 1 && alphas.size <= 5, `Up to five alphas (${[...alphas]})`)
  const map = await api(
    `/contests/${PRESIDENT}/map?level=state&metric=candidateShare&candidateId=${encodeURIComponent(LULA_ID)}`,
  )
  const unavailable = map.items.filter((item) => item.state !== 'available' || item.value === null)
  await until(
    () => legendTitle() && legend().querySelector('[title="Sem resultado nesta publicação"]'),
    'Open legend',
  )
  const missing = Number(
    legend().querySelector('[title="Sem resultado nesta publicação"]').dataset.count,
  )
  assert(
    missing === unavailable.length,
    `Unavailable states unpainted (${missing} vs ${unavailable.length})`,
  )
  const rows = [...legend().querySelectorAll('[data-map-legend-rows] [data-count]')]
  const painted = rows.reduce((sum, row) => sum + Number(row.dataset.count), 0)
  assert(painted === map.items.length - unavailable.length, 'Painted states = available states')
  return `Focus map passed: ${LULA_COLOR} fills with ${alphas.size} alpha(s), ${painted} states painted, ${unavailable.length} unavailable unpainted`
}

export async function checkFocusValues() {
  go(`${PORTO_WALTER}&candidate=${LULA}`)
  await until(() => card()?.dataset.candidateCard === LULA && settled(), 'Card in Porto Walter')
  await expandSheet()
  await until(() => card().querySelector('[data-focus-scope-contribution]'), 'Measures')
  const results = await api(`/contests/${PRESIDENT}/results?areaId=ac:01066`)
  const row = results.candidates.find((item) => item.candidate.officialId === LULA)
  const support = card().querySelector('[data-focus-support]')
  close(support.dataset.focusSupport, row.share.value, 'Support = /results share')
  assert(Number(support.dataset.votes) === row.votes, 'Votes = /results row')
  const byState = await api(
    `/contests/${PRESIDENT}/distribution?candidateId=${encodeURIComponent(LULA_ID)}&areaId=ac&level=municipality&limit=100`,
  )
  const item = byState.items.find((entry) => entry.area.id === 'ac:01066')
  const contribution = card().querySelector('[data-focus-contribution]')
  close(
    contribution.dataset.focusContribution,
    item.contribution.value,
    'Contribution = /distribution',
  )
  const byCountry = await api(
    `/contests/${PRESIDENT}/distribution?candidateId=${encodeURIComponent(LULA_ID)}&areaId=br&level=state&limit=1`,
  )
  const scope = card().querySelector('[data-focus-scope-contribution]')
  close(
    scope.dataset.focusScopeContribution,
    (row.votes / byCountry.items[0].contribution.denominator) * 100,
    'Contribution in Brazil',
  )
  assert(card().textContent.includes('Apoio em Porto Walter: 50,95%'), 'Support label')
  assert(card().textContent.includes('Contribuição para o Acre: 2,38%'), 'Contribution label')
  // Distribution by zone equals /distribution.
  const zones = await api(
    `/contests/${PRESIDENT}/distribution?candidateId=${encodeURIComponent(LULA_ID)}&areaId=ac:01066&level=zone&sort=votes&limit=25`,
  )
  await until(
    () => panel().querySelectorAll('[data-distribution-item]').length === zones.items.length,
    'Zones',
  )
  for (const zone of zones.items) {
    const node = panel().querySelector(`[data-distribution-item="${zone.area.id}"]`)
    assert(
      node.querySelector('[data-distribution-votes]').textContent ===
        zone.votes.toLocaleString('pt-BR'),
      `Zone ${zone.area.id} votes`,
    )
  }
  // State list: sort and pagination.
  go(`/br?collection=elections&office=president&state=12&candidate=${FLAVIO}`)
  await until(
    () =>
      card()?.dataset.candidateCard === FLAVIO &&
      panel().querySelector('[data-distribution-total]'),
    'Flávio in Acre',
  )
  await expandSheet()
  await until(() => card().querySelector('[data-focus-contribution]'), 'Acre measures')
  assert(card().textContent.includes('Apoio no Acre: 64,56%'), 'Support in Acre')
  assert(card().textContent.includes('Contribuição para o Brasil: 0,54%'), 'Acre → Brazil')
  assert(!card().querySelector('[data-focus-scope-contribution]'), 'No second line in a state')
  const list = panel().querySelector('[data-candidate-distribution]')
  assert(list.dataset.candidateDistribution === 'municipality', 'Municipal distribution')
  assert(
    panel().querySelector('[data-distribution-total]').dataset.distributionTotal === '22',
    '22 municipalities',
  )
  assert(list.querySelectorAll('[data-distribution-item]').length === 22, 'One page of 22')
  const unavailable = [...list.querySelectorAll('[data-distribution-item]')].filter((node) =>
    node.textContent.includes('sem dados'),
  ).length
  assert(unavailable === 21, `21 without data (${unavailable})`)
  button(list.querySelector('[aria-label="Ordenar por"]'), 'Código').click()
  await until(() => list.dataset.distributionSort === 'area', 'Sort by area code')
  await until(
    () => list.querySelector('[data-distribution-item]')?.dataset.distributionItem === 'ac:01007',
    'Bujari first by code',
  )
  assert(!search().has('sort'), 'Sort stays out of the URL')
  go(`/br?collection=elections&office=president&candidate=${LULA}`)
  await until(
    () => panel().querySelector('[data-distribution-total]')?.dataset.distributionTotal === '28',
    'States',
  )
  await expandSheet()
  const states = panel().querySelector('[data-candidate-distribution]')
  assert(states.querySelectorAll('[data-distribution-item]').length === 25, 'First page of 25')
  button(states.parentElement, 'Mostrar mais').click()
  await until(
    () => states.querySelectorAll('[data-distribution-item]').length === 28,
    'Second page',
  )
  // Selecting a state from the list keeps the focus.
  states.querySelector('[data-distribution-item="ac"] button').click()
  await until(
    () => search().get('state') === '12' && search().get('candidate') === LULA,
    'Acre kept focus',
  )
  return 'Focus values passed: card equals /results and /distribution in Porto Walter, zones, sort, pagination, state selection keeps the focus'
}

export async function checkFocusContributionMap() {
  const record = recordRequests()
  const contributionMaps = (urls = record.requests) =>
    urls
      .filter((url) => url.includes('/map?') && url.includes('metric=contribution'))
      .map((url) => new URL(url).searchParams)
  try {
    go(`/br?collection=elections&office=president&state=12&candidate=${LULA}&metric=contribution`)
    await until(() => card()?.dataset.candidateCard === LULA && settled(), 'Lula in Acre')
    await until(() => legend()?.dataset.mapLegend === 'ready', 'Legend ready')
    await until(
      () => legendTitle() === 'Contribuição de Lula (13 · PT) para o Acre',
      'Contribution legend for Acre',
    )
    const basis = legend().querySelector('[data-map-legend-basis]')?.textContent
    assert(basis === 'Percentuais dos votos do candidato no escopo', `Basis line (${basis})`)
    assert(
      legend().querySelector('[data-map-legend-scope]')?.textContent ===
        'Cada área sobre os votos de Lula no Acre',
      'Scope line',
    )
    const map = await api(
      `/contests/${PRESIDENT}/map?level=municipality&metric=contribution&areaId=ac&candidateId=${encodeURIComponent(LULA_ID)}`,
    )
    assert(map.items[0].state !== 'available', 'The first item is unavailable in the pilot')
    // A municipality at municipal grain compares with its siblings: the map stays on Acre.
    go(`${PORTO_WALTER}&candidate=${LULA}&metric=contribution`)
    await until(() => card()?.dataset.candidateCard === LULA && settled(), 'Lula in Porto Walter')
    await until(
      () => legendTitle() === 'Contribuição de Lula (13 · PT) para o Acre',
      'Porto Walter keeps the Acre scope',
    )
    assert(
      contributionMaps().every((params) => params.get('areaId') === 'ac'),
      'Contribution maps scoped to Acre',
    )
    navigateElection({ level: 'state' })
    await until(
      () => legendTitle() === 'Contribuição de Lula (13 · PT) para o Brasil',
      'State grain scoped to Brazil',
    )
    // An earlier check may have cached the national state map, so the cache keys count too.
    assert(
      contributionMaps([...record.requests, ...cachedKeys()]).some(
        (params) => params.get('areaId') === 'br' && params.get('level') === 'state',
      ),
      'State grain request scoped to Brazil',
    )
    return 'Contribution map passed: Acre legend with the contribution basis despite unavailable first items, municipality and state grain scoped to the parent'
  } finally {
    record.restore()
  }
}

export async function checkFocusScopes() {
  go(`/br?collection=elections&office=governor&candidate=${MAILZA}`)
  await until(() => panel()?.querySelector('[data-national-view]'), 'National view')
  await expandSheet()
  assert(panel().querySelector('[data-focus-national-note]'), 'National note')
  assert(!card(), 'No card in the national view')
  go(`/br?collection=elections&office=governor&state=12&candidate=${MAILZA}`)
  await until(() => card()?.dataset.candidateCard === MAILZA, 'Mailza in Acre')
  await expandSheet()
  assert(
    card().textContent.includes('Coligação:') && card().textContent.includes('Vice:'),
    'Coalition and vice',
  )
  // Ranking mode: federal deputies in Acre, focus by clicking the first row.
  go('/br?collection=elections&office=federal-deputy&state=12')
  await until(() => panel()?.querySelector('[data-candidate-list=ranking]') && settled(), 'Ranking')
  await expandSheet()
  const first = panel().querySelector('[data-candidate-row] button')
  first.click()
  await until(() => card() && search().has('candidate'), 'Deputy focus')
  await until(() => legendTitle().startsWith('Apoio a'), 'Support map for a deputy')
  assert(first.ariaPressed === 'true', 'Ranking row pressed')
  return 'Focus scopes passed: national note, governor coalition and vice, ranking focus with support map'
}
