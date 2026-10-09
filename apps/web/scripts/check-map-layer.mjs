// Node check of the pure map classifier: node scripts/check-map-layer.mjs
import assert from 'node:assert/strict'
import {
  TIE_CLASS_ID,
  classifyMap,
  legendCounts,
  metricBands,
} from '../src/features/elections/map-classes.ts'

const PT = {
  id: 'c:pt',
  officialId: '13',
  number: '13',
  displayName: 'LULA',
  color: '#ee2d35',
  photoUrl: null,
  party: { number: '13', abbreviation: 'PT', name: 'Partido dos Trabalhadores', displayName: null },
  contestId: 'BR-2026-1:6257:1:br',
}
const PL = {
  ...PT,
  id: 'c:pl',
  displayName: 'FLAVIO',
  color: '#4466e7',
  party: { ...PT.party, abbreviation: 'PL' },
}
const PT2 = {
  ...PT,
  id: 'c:pt2',
  displayName: 'RUI',
  color: '#db34a2',
  contestId: 'BR-2026-1:6259:5:ba',
}
const PT3 = { ...PT, id: 'c:pt3', displayName: 'HUMBERTO', contestId: 'BR-2026-1:6259:5:pe' }

function item(featureId, overrides = {}) {
  return {
    areaId: `x:${featureId}`,
    featureId,
    value: 1000,
    state: 'available',
    sourceKind: 'EA20',
    basis: 'recordedCandidateVotesSum',
    leaders: ['c:pt'],
    tie: false,
    complete: true,
    margin: 10,
    ...overrides,
  }
}

function response(items, overrides = {}) {
  return {
    publicationId: 'pub',
    coverage: { scope: 'pilot' },
    contestId: 'BR-2026-1:6257:1:br',
    scopeAreaId: 'br',
    level: 'municipality',
    metric: 'leader',
    candidateId: null,
    items,
    candidates: { 'c:pt': PT, 'c:pl': PL },
    omittedWithoutGeometry: 0,
    missingResults: 0,
    ...overrides,
  }
}

const fillOf = (classified, id) => classified.layer.fills.get(id)
const classOf = (classified, id) => classified.layer.classes.get(fillOf(classified, id).classId)

// Leader bands at the limits, null margin, tie, hidden leaders, unavailable and partial.
{
  const classified = classifyMap(
    response([
      item('1200013', { margin: 4.99 }),
      item('1200054', { margin: 5 }),
      item('1200104', { margin: 15 }),
      item('1200138', { margin: 30 }),
      item('1200179', { margin: null }),
      item('1200203', { tie: true, leaders: ['c:pt', 'c:pl'], margin: 0 }),
      item('1200252', { leaders: [], value: null }),
      item('1200302', { state: 'unavailable', value: null, leaders: [], complete: false }),
      item('1200328', { complete: false }),
      item('1200336', { leaders: ['c:pl'], margin: 40 }),
      item('3550308', { leaders: ['c:pl'], margin: 2 }),
    ]),
  )
  assert.equal(classified.grain, 'municipality')
  assert.equal(classified.cross, false)
  assert.deepEqual(
    ['1200013', '1200054', '1200104', '1200138', '1200179'].map(
      (id) => classOf(classified, id).alpha,
    ),
    [0.35, 0.55, 0.78, 1, 0.35],
    'Margin bands break at 5, 15 and 30 p.p.; a null margin takes the lowest band',
  )
  assert.equal(classOf(classified, '1200013').color, '#ee2d35')
  assert.equal(classOf(classified, '1200013').label, 'LULA (PT) <5')
  assert.equal(fillOf(classified, '1200203').classId, TIE_CLASS_ID)
  assert.deepEqual(classified.layer.classes.get(TIE_CLASS_ID).color, { token: 'muted-foreground' })
  assert.equal(fillOf(classified, '1200252'), undefined, 'Hidden leaders stay on the base')
  assert.equal(fillOf(classified, '1200302'), undefined, 'Unavailable stays on the base')
  assert.equal(fillOf(classified, '1200328').partial, true)
  assert.equal(fillOf(classified, '1200013').partial, false)
  assert.equal(classified.items.size, 11)
  assert.deepEqual(
    classified.groups.map((group) => group.label),
    ['LULA (PT)', 'FLAVIO (PL)'],
  )

  const national = legendCounts(classified, null)
  assert.equal(national.total, 11)
  assert.equal(national.missing, 2)
  assert.equal(national.tie, 1)
  assert.equal(national.partial, 1)
  assert.equal(national.painted, 9)
  assert.deepEqual(
    national.rows.map((row) => [row.label, row.count]),
    [
      ['LULA (PT)', 6],
      ['FLAVIO (PL)', 2],
    ],
    'Leader rows sorted by count',
  )
  assert.deepEqual(
    national.rows[0].bands.map((band) => band.count),
    [2, 2, 1, 1],
    'Per-band counts of the leader row',
  )
  assert.equal(
    national.rows.reduce((sum, row) => sum + row.count, 0) + national.tie + national.missing,
    national.total,
    'Rows, tie and missing add up to the scope',
  )
  assert.deepEqual(national.scale, ['<5', '5–15', '15–30', '≥30'])
  assert.equal(national.unit, 'pp')

  const acre = legendCounts(classified, '12')
  assert.equal(acre.total, 10, 'A selected state filters the counts by IBGE prefix')
  assert.deepEqual(
    acre.rows.map((row) => [row.label, row.count]),
    [
      ['LULA (PT)', 6],
      ['FLAVIO (PL)', 1],
    ],
  )
}

// State grain ignores the scope filter; the key separates metrics.
{
  const leader = classifyMap(
    response([item('12'), item('35', { leaders: ['c:pl'] })], { level: 'state' }),
  )
  assert.equal(legendCounts(leader, '12').total, 2)
  const margin = classifyMap(
    response([item('12', { value: 10 }), item('35', { value: null, leaders: ['c:pl'] })], {
      level: 'state',
      metric: 'margin',
    }),
  )
  assert.notEqual(leader.layer.key, margin.layer.key)
  assert.deepEqual(classOf(margin, '12').color, { token: 'foreground' })
  assert.equal(classOf(margin, '12').alpha, 0.45)
  assert.equal(fillOf(margin, '35'), undefined, 'Null margin value stays on the base')
  assert.equal(margin.groups.length, 1)
  assert.equal(legendCounts(margin, null).rows[0].bands.length, 4)
}

// Sequential metrics: turnout on the neutral ramp, candidate metrics on the candidate colour.
{
  const turnout = classifyMap(
    response(
      [59.9, 60, 70, 75, 80, null].map((value, index) =>
        item(`120000${index}`, { value, leaders: [] }),
      ),
      { metric: 'turnout' },
    ),
  )
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((index) => classOf(turnout, `120000${index}`).alpha),
    [0.12, 0.28, 0.45, 0.62, 0.8],
  )
  assert.equal(fillOf(turnout, '1200005'), undefined)
  assert.deepEqual(classOf(turnout, '1200000').color, { token: 'foreground' })
  const counts = legendCounts(turnout, null)
  assert.deepEqual(
    counts.rows[0].bands.map((band) => [band.label, band.count]),
    [
      ['<60', 1],
      ['60–70', 1],
      ['70–75', 1],
      ['75–80', 1],
      ['≥80', 1],
    ],
  )
  assert.equal(counts.missing, 1)

  const share = classifyMap(
    response(
      [9.9, 10, 25, 40, 55].map((value, index) => item(`120000${index}`, { value })),
      { metric: 'candidateShare', candidateId: 'c:pl' },
    ),
  )
  assert.equal(share.candidate.displayName, 'FLAVIO')
  assert.equal(classOf(share, '1200000').color, '#4466e7')
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((index) => classOf(share, `120000${index}`).alpha),
    [0.2, 0.4, 0.6, 0.8, 1],
  )
  assert.deepEqual(metricBands('contribution').breaks, [0.1, 0.5, 2, 10])
  const contribution = classifyMap(
    response(
      [0.09, 0.1, 0.5, 2, 10].map((value, index) => item(`120000${index}`, { value })),
      { metric: 'contribution', candidateId: 'c:pt' },
    ),
  )
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((index) => classOf(contribution, `120000${index}`).alpha),
    [0.2, 0.4, 0.6, 0.8, 1],
  )
  const votes = classifyMap(
    response(
      [999, 1e3, 1e4, 1e5, 1e6].map((value, index) => item(`120000${index}`, { value })),
      { metric: 'candidateVotes', candidateId: 'c:pt' },
    ),
  )
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((index) => classOf(votes, `120000${index}`).alpha),
    [0.2, 0.4, 0.6, 0.8, 1],
  )
  assert.deepEqual(legendCounts(votes, null).scale, [
    '<1 mil',
    '1–10 mil',
    '10–100 mil',
    '100 mil–1 mi',
    '≥1 mi',
  ])
  assert.equal(legendCounts(votes, null).unit, 'votes')
}

// Cross maps group by colour and party, label by party, and keep two colours of one party apart.
{
  const cross = classifyMap({
    publicationId: 'pub',
    coverage: { scope: 'pilot' },
    tseElectionId: '6259',
    officeCode: '5',
    level: 'state',
    metric: 'leader',
    contests: [],
    items: [
      item('29', { leaders: ['c:pt2'], contestId: 'BR-2026-1:6259:5:ba' }),
      item('26', { leaders: ['c:pt3'], contestId: 'BR-2026-1:6259:5:pe' }),
      item('12', { leaders: ['c:pt'], contestId: 'BR-2026-1:6259:5:ac' }),
      item('35', { leaders: ['c:pl'], contestId: 'BR-2026-1:6259:5:sp' }),
    ],
    candidates: { 'c:pt': PT, 'c:pl': PL, 'c:pt2': PT2, 'c:pt3': PT3 },
    omittedWithoutGeometry: 0,
    missingResults: 0,
  })
  assert.equal(cross.cross, true)
  assert.equal(cross.layer.key.includes('office:5'), true)
  assert.deepEqual(
    cross.groups.map((group) => [group.label, group.candidates]),
    [
      ['PT (RUI)', ['RUI']],
      ['PT (HUMBERTO, LULA)', ['HUMBERTO', 'LULA']],
      ['PL', ['FLAVIO']],
    ],
  )
  assert.equal(
    fillOf(cross, '26').classId,
    fillOf(cross, '12').classId,
    'Same colour and party share the class',
  )
  assert.notEqual(fillOf(cross, '29').classId, fillOf(cross, '12').classId)
  const counts = legendCounts(cross, null)
  assert.deepEqual(
    counts.rows.map((row) => [row.label, row.count, row.title]),
    [
      ['PT (HUMBERTO, LULA)', 2, 'HUMBERTO, LULA'],
      ['PT (RUI)', 1, 'RUI'],
      ['PL', 1, 'FLAVIO'],
    ],
  )
}

console.log(
  'Map layer classifier checks passed: bands, tie, missing, partial, labels, scope counts',
)
