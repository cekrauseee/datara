import assert from 'node:assert/strict'
import {
  ELECTION_PARAMETERS,
  clearElectionParameters,
  electionURL,
  readElection,
  withoutElectionParameters,
} from '../src/features/elections/election-location.ts'
import { locationURL, readLocation } from '../src/features/map/map-location.ts'

const origin = 'https://maps.example'
const url = (path) => new URL(path, origin)
const publication = '2a4cee03-930c-4377-b383-fcb27f9da55d'
const inert = {
  collection: null,
  office: null,
  level: 'municipality',
  metric: 'leader',
  candidate: null,
  zone: null,
  section: null,
  area: null,
  publication: null,
  round: 1,
  warnings: [],
}

// Without the collection nothing else is read; publication and round survive on /br only.
assert.deepEqual(readElection(url('/br?state=35')), inert)
assert.deepEqual(readElection(url('/br?office=president&state=35&candidate=1')), inert)
assert.deepEqual(readElection(url('/br?collection=statistics&office=president')), inert)
assert.deepEqual(readElection(url(`/br?publication=${publication}&round=2`)), {
  ...inert,
  publication,
  round: 2,
})
assert.deepEqual(
  readElection(url(`/us?collection=elections&office=president&publication=${publication}`)),
  inert,
)
assert.equal(
  readElection(url('/maps/br?collection=elections&office=governor'), '/maps/').office,
  'governor',
)

// Every parameter read back.
assert.deepEqual(
  readElection(
    url(
      `/br?collection=elections&office=governor&level=state&metric=margin&state=12&municipality=1200401&zone=0009&section=0077&publication=${publication}&round=2`,
    ),
  ),
  {
    collection: 'elections',
    office: 'governor',
    level: 'state',
    metric: 'margin',
    candidate: null,
    zone: '0009',
    section: '0077',
    area: null,
    publication,
    round: 2,
    warnings: [],
  },
)

// Defaults and invalid tokens.
const base = '/br?collection=elections&office=president'
assert.equal(readElection(url(`${base}&candidate=280002542548`)).metric, 'share')
assert.equal(readElection(url(`${base}&candidate=280002542548&metric=leader`)).metric, 'leader')
assert.equal(readElection(url(`${base}&metric=share`)).metric, 'leader')
assert.equal(readElection(url(`${base}&metric=contribution`)).metric, 'leader')
assert.equal(readElection(url(`${base}&metric=bogus`)).metric, 'leader')
assert.equal(readElection(url('/br?collection=elections&office=mayor')).office, null)
assert.equal(readElection(url('/br?collection=elections&level=county')).level, 'municipality')
assert.equal(readElection(url('/br?collection=elections&round=3')).round, 1)
assert.equal(readElection(url('/br?collection=elections&publication=not-a-uuid')).publication, null)
assert.equal(readElection(url(`${base}&candidate=12a`)).candidate, null)
const emptyCandidate = readElection(url(`${base}&candidate=`))
assert.equal(emptyCandidate.candidate, null)
assert.equal(emptyCandidate.warnings.length, 1)

// Zone needs a municipality, section needs a zone, both are four digits; `area` wins over IBGE codes.
const zoneWithoutMunicipality = readElection(url(`${base}&state=12&zone=0009`))
assert.equal(zoneWithoutMunicipality.zone, null)
assert.equal(zoneWithoutMunicipality.warnings.length, 1)
const sectionWithoutZone = readElection(url(`${base}&state=12&municipality=1200401&section=0077`))
assert.equal(sectionWithoutZone.section, null)
assert.equal(sectionWithoutZone.warnings.length, 1)
assert.equal(readElection(url(`${base}&municipality=1200401&zone=9`)).zone, null)
for (const area of ['exterior', 'zz:29173', 'region:north'])
  assert.equal(readElection(url(`${base}&area=${area}`)).area, area)
assert.equal(readElection(url(`${base}&area=moon`)).area, null)
assert.equal(readElection(url(`${base}&area=exterior&municipality=1200401&zone=0009`)).zone, null)

// Writer: choosing the collection, leaving it, changing office, metrics and areas.
assert.equal(
  electionURL(url('/br?state=35&utm_source=x#top'), {
    collection: 'elections',
    office: 'president',
  }),
  '/br?state=35&utm_source=x&collection=elections&office=president#top',
)
assert.equal(
  electionURL(
    url(
      `/br?state=35&collection=elections&office=governor&candidate=1&level=state&publication=${publication}`,
    ),
    { collection: null },
  ),
  `/br?state=35&publication=${publication}`,
)
assert.equal(
  electionURL(url(`${base}&candidate=1`), { office: 'governor' }),
  '/br?collection=elections&office=governor',
)
assert.equal(electionURL(url(`${base}&candidate=1`), { office: null }), '/br?collection=elections')
assert.equal(
  electionURL(url(`${base}&candidate=1`), { level: 'state' }),
  '/br?collection=elections&office=president&level=state&candidate=1',
)
assert.equal(
  electionURL(url(`${base}&candidate=1`), { office: 'governor', candidate: '2' }),
  '/br?collection=elections&office=governor&candidate=2',
)
assert.equal(electionURL(url(`${base}&candidate=1&metric=votes`), { candidate: null }), base)
assert.equal(electionURL(url(base), { candidate: '1', metric: 'share' }), `${base}&candidate=1`)
assert.equal(
  electionURL(url(base), { candidate: '1', metric: 'leader' }),
  `${base}&metric=leader&candidate=1`,
)
assert.equal(
  electionURL(url(base), { metric: 'turnout', level: 'state' }),
  `${base}&level=state&metric=turnout`,
)
assert.equal(
  electionURL(
    url('/br?state=12&municipality=1200401&collection=elections&office=president&zone=0009'),
    {
      area: 'exterior',
    },
  ),
  '/br?collection=elections&office=president&area=exterior',
)
assert.equal(
  electionURL(url('/br?state=12&collection=elections&office=president'), { zone: '0009' }),
  '/br?state=12&collection=elections&office=president',
)
assert.equal(
  electionURL(url('/br?state=12&municipality=1200401&collection=elections&office=president'), {
    zone: '0009',
    section: '0077',
  }),
  '/br?state=12&municipality=1200401&collection=elections&office=president&zone=0009&section=0077',
)
assert.equal(electionURL(url(`${base}&round=2`), { level: 'state' }), `${base}&level=state&round=2`)

// Round trip keeps the geography untouched.
const written = electionURL(
  url(`/br?state=12&municipality=1200401&publication=${publication}&round=2`),
  {
    collection: 'elections',
    office: 'senator',
    level: 'state',
    metric: 'turnout',
    zone: '0009',
    section: '0077',
  },
)
assert.deepEqual(readElection(url(written)), {
  collection: 'elections',
  office: 'senator',
  level: 'state',
  metric: 'turnout',
  candidate: null,
  zone: '0009',
  section: '0077',
  area: null,
  publication,
  round: 2,
  warnings: [],
})
assert.deepEqual(readLocation(url(written)), { countryCode: 'BR', selectionId: '1200401' })

// Geographic navigation: locationURL followed by clearElectionParameters, as navigateMap does.
const ac = { id: '12', countryCode: 'BR', type: 'state', geoid: '12', stateCode: '12' }
const rioBranco = {
  id: '1200401',
  countryCode: 'BR',
  type: 'municipality',
  geoid: '1200401',
  stateCode: '12',
}
const saoPaulo = {
  id: '3550308',
  countryCode: 'BR',
  type: 'municipality',
  geoid: '3550308',
  stateCode: '35',
}
function navigate(from, countryCode, area) {
  const source = url(from)
  const next = new URL(locationURL(source, countryCode, area), origin)
  const previous = readLocation(source)
  clearElectionParameters(next, {
    countryCode,
    previousSelectionId: previous.countryCode === 'BR' ? previous.selectionId : null,
  })
  return `${next.pathname}${next.search}${next.hash}`
}
assert.equal(
  navigate(`${base}&level=state`, 'BR', ac),
  '/br?state=12&collection=elections&office=president&level=state',
)
assert.equal(
  navigate(base, 'BR', saoPaulo),
  '/br?state=35&municipality=3550308&collection=elections&office=president',
)
assert.equal(
  navigate(
    '/br?state=12&municipality=1200401&collection=elections&office=president&zone=0009&section=0077',
    'BR',
    saoPaulo,
  ),
  '/br?state=35&municipality=3550308&collection=elections&office=president',
)
assert.equal(
  navigate(
    '/br?state=12&municipality=1200401&collection=elections&office=president&zone=0009',
    'BR',
    rioBranco,
  ),
  '/br?state=12&municipality=1200401&collection=elections&office=president&zone=0009',
)
assert.equal(
  navigate(
    '/br?state=12&municipality=1200401&collection=elections&office=president&candidate=1&zone=0009',
    'BR',
    ac,
  ),
  '/br?state=12&collection=elections&office=president&candidate=1',
)
assert.equal(
  navigate('/br?state=12&collection=elections&office=governor&candidate=1', 'BR', saoPaulo),
  '/br?state=35&municipality=3550308&collection=elections&office=governor',
)
assert.equal(
  navigate('/br?state=12&collection=elections&office=governor&candidate=1', 'BR', rioBranco),
  '/br?state=12&municipality=1200401&collection=elections&office=governor&candidate=1',
)
assert.equal(
  navigate('/br?state=12&collection=elections&office=governor&candidate=1', 'BR', null),
  '/br?collection=elections&office=governor',
)
assert.equal(
  navigate(
    '/br?state=26&municipality=2605459&collection=elections&office=council&candidate=1',
    'BR',
    rioBranco,
  ),
  '/br?state=12&municipality=1200401&collection=elections&office=council',
)
assert.equal(
  navigate(`${base}&area=exterior`, 'BR', ac),
  '/br?state=12&collection=elections&office=president',
)
assert.equal(navigate(`${base}&area=exterior`, 'BR', null), `${base}&area=exterior`)
assert.equal(
  navigate(
    `/br?state=35&collection=elections&office=president&candidate=1&publication=${publication}&round=2&utm_source=t`,
    'US',
    null,
  ),
  '/us?utm_source=t',
)
assert.equal(navigate('/br?state=35&municipality=3550308', 'BR', ac), '/br?state=12')
assert.equal(navigate('/br?state=35', 'US', null), '/us')
assert.equal(navigate('/', 'BR', null), '/br')
assert.equal(navigate('/us?state=36', 'BR', ac), '/br?state=12')

// Leaving Brazil through a retained location.
assert.equal(
  withoutElectionParameters('/us?state=36&collection=elections&office=president#x'),
  '/us?state=36#x',
)
assert.equal(withoutElectionParameters('/us?state=36&q=a%20b'), '/us?state=36&q=a%20b')
assert.deepEqual(
  [...ELECTION_PARAMETERS],
  [
    'collection',
    'office',
    'level',
    'metric',
    'candidate',
    'zone',
    'section',
    'area',
    'publication',
    'round',
  ],
)

console.log(
  'Election URL checks passed: collection gate, every parameter, defaults, dependencies, writer clearing, round trip, geographic clearing and country switching',
)
