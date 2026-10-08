import assert from 'node:assert/strict'
import {
  aggregateCoverage,
  areaAllowed,
  areaKind,
  childLevel,
  findByCode,
  isCombinationError,
  localClock,
  principalCode,
  printedSum,
  printedTotals,
  regionName,
  undetermined,
  unresolvedNote,
} from '../src/features/elections/depth.ts'
import {
  clearElectionParameters,
  electionURL,
  readElection,
} from '../src/features/elections/election-location.ts'
import { locationURL } from '../src/features/map/map-location.ts'

const origin = 'https://maps.example'
const url = (path) => new URL(path, origin)
const base = '/br?collection=elections&office=president'

// Area kinds and the office rule.
assert.equal(areaKind('exterior'), 'exterior')
assert.equal(areaKind('zz:29262'), 'locality')
assert.equal(areaKind('region:north'), 'region')
assert.equal(areaKind('ac:01066'), null)
assert.equal(areaKind(null), null)
assert.equal(areaAllowed('president'), true)
assert.equal(areaAllowed('governor'), false)
assert.equal(areaAllowed(null), false)

// Region names: the English IDs of the active publication fall back to Portuguese.
assert.equal(regionName({ id: 'region:north', name: 'north' }), 'Norte')
assert.equal(regionName({ id: 'region:centralwest', name: 'centralwest' }), 'Centro-Oeste')
assert.equal(regionName('region:northeast'), 'Nordeste')
assert.equal(regionName({ id: 'region:south', name: 'Região Sul' }), 'Região Sul')

// Lookups by code, never by splitting IDs.
const zone = { id: 'ac:01066:0004', zoneCode: '0004', sectionCode: null }
const sections = [
  { id: 'df:97012:0002:0471', zoneCode: '0002', sectionCode: '0471', principalAreaId: null },
  {
    id: 'df:97012:0002:0472',
    zoneCode: '0002',
    sectionCode: '0472',
    principalAreaId: 'df:97012:0002:0471',
  },
]
assert.equal(findByCode([zone], 'zone', '0004'), zone)
assert.equal(findByCode([zone], 'zone', '0009'), null)
assert.equal(findByCode(sections, 'section', '0472'), sections[1])
assert.equal(principalCode(sections, 'df:97012:0002:0471'), '0471')
assert.equal(principalCode(sections, 'df:97012:0002:0999'), null)
assert.equal(principalCode(sections, null), null)

// Levels below: zone in a municipality, section in a zone, locality in the exterior, state in a
// region, nothing in a section.
assert.equal(childLevel({ id: 'ac:01066', level: 'municipality' }), 'zone')
assert.equal(childLevel({ id: 'zz:29262', level: 'municipality' }), 'zone')
assert.equal(childLevel({ id: 'ac:01066:0004', level: 'zone' }), 'section')
assert.equal(childLevel({ id: 'exterior', level: 'state' }), 'municipality')
assert.equal(childLevel({ id: 'region:north', level: 'region' }), 'state')
assert.equal(childLevel({ id: 'ac:01066:0004:0077', level: 'section' }), null)

// Provenance helpers.
assert.equal(
  aggregateCoverage('Sum of disjoint domestic UF EA20 results (7/7 states); exterior excluded'),
  '7/7',
)
assert.equal(aggregateCoverage('Official judicial totalization'), null)
assert.equal(localClock('2026-10-04T17:10:20'), '04/10/2026 17:10')
assert.equal(localClock('2026-10-05T12:51:41-03:00'), null)
assert.equal(isCombinationError({ code: 'LEVEL_TOO_DEEP' }), true)
assert.equal(isCombinationError({ code: 'AREA_NOT_FOUND' }), false)

// Printed totals of a BU: the five types sum to totalVotes; a null type breaks the sum.
const totals = {
  nominalVotes: 240,
  legendVotes: 0,
  blankVotes: 8,
  nullVotes: 1,
  noCandidateVotes: null,
}
assert.deepEqual(
  printedTotals(totals).map((entry) => entry.label),
  ['Nominais', 'Legenda', 'Brancos', 'Nulos', 'Sem candidato'],
)
assert.equal(printedTotals(totals)[4].note, 'não registrado nesta publicação')
assert.equal(printedSum(printedTotals(totals)), null)
assert.equal(printedSum(printedTotals({ ...totals, noCandidateVotes: 0 })), 249)
assert.equal(
  unresolvedNote([{ number: '55', voteType: '1', partyNumber: '55', votes: 1 }]),
  '1 votável sem candidatura verificada: nº 55 (1 voto)',
)
assert.equal(unresolvedNote([]), null)
assert.equal(undetermined({ summary: null }), false)
assert.equal(
  undetermined({
    summary: { leaders: [], margin: { votes: 3, basis: 'printedNominalVotes' } },
  }),
  true,
)
assert.equal(
  undetermined({
    summary: { leaders: ['x'], margin: { votes: null, basis: 'unresolvedPrintedCandidateVotes' } },
  }),
  true,
)

// URL: an exterior locality keeps zone and section like a municipality; the exterior and the
// regions do not.
const locality = readElection(url(`${base}&area=zz:29254&zone=0001&section=0001`))
assert.equal(locality.zone, '0001')
assert.equal(locality.section, '0001')
assert.equal(readElection(url(`${base}&area=exterior&zone=0001`)).zone, null)
assert.equal(readElection(url(`${base}&area=region:north&zone=0001`)).zone, null)

// Writer: a zone drops the section; another area drops zone and section; a locality row writes
// `area` and removes the geography.
const porto = '/br?state=12&municipality=1200393&collection=elections&office=president'
assert.equal(
  electionURL(url(`${porto}&zone=0004&section=0077`), { zone: '0005' }),
  `${porto}&zone=0005`,
)
assert.equal(
  electionURL(url(`${porto}&zone=0004&section=0077`), { section: '0080' }),
  `${porto}&zone=0004&section=0080`,
)
assert.equal(
  electionURL(url(`${porto}&zone=0004&section=0077`), { area: 'exterior' }),
  `${base}&area=exterior`,
)
assert.equal(
  electionURL(url(`${base}&area=exterior`), { area: 'zz:29262' }),
  `${base}&area=zz%3A29262`,
)
assert.equal(
  electionURL(url(`${base}&area=zz:29254&zone=0001&section=0001`), { area: 'zz:29262' }),
  `${base}&area=zz%3A29262`,
)
assert.equal(
  electionURL(url(`${base}&area=zz:29254`), { zone: '0001', section: null }),
  `${base}&zone=0001&area=zz%3A29254`,
)
assert.equal(electionURL(url(`${base}&area=region:north`), { area: null }), base)

// Geography after an area: choosing a state or municipality removes `area`, zone and section.
function navigate(from, area) {
  const source = url(from)
  const next = new URL(locationURL(source, 'BR', area), origin)
  clearElectionParameters(next, { countryCode: 'BR', previousSelectionId: null })
  return `${next.pathname}${next.search}`
}
const acre = { id: '12', countryCode: 'BR', type: 'state', geoid: '12', stateCode: '12' }
assert.equal(
  navigate(`${base}&area=zz:29254&zone=0001&section=0001`, acre),
  '/br?state=12&collection=elections&office=president',
)

console.log(
  'Election depth checks passed: area kinds and office rule, region names, lookups by code, levels below, provenance helpers, printed totals, locality zones in the URL and clearing',
)
