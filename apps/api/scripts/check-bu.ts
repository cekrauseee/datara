import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { decodeBu } from '../src/modules/elections/ingestion/bu.js'
const bytes = await readFile(new URL('../test/fixtures/porto-walter-0077-bu.dat', import.meta.url))
const bu = decodeBu(bytes)
assert.deepEqual([bu.municipality, bu.zone, bu.section, bu.turnout], ['01066', '0004', '0077', 234])
assert.deepEqual(
  bu.elections.map((e) => [e.electionId, e.eligible]),
  [
    ['6257', 289],
    ['6259', 289],
  ],
)
const results = bu.elections
  .flatMap((e) => e.offices)
  .map((o) => [o.officeCode, o.votes.reduce((n, v) => n + v.votes, 0)])
assert.deepEqual(results, [
  ['1', 234],
  ['6', 234],
  ['7', 234],
  ['5', 468],
  ['3', 234],
])
assert.throws(() => decodeBu(bytes.subarray(0, bytes.length - 1)), /Truncated/)
assert.equal(bu.elections[0]?.offices[0]?.votes.find((v) => v.number === '13')?.votes, 99)
console.log(
  'BU2026 real fixture: identity, presidency, two-choice Senate, proportional legend, truncation passed',
)
const exterior = decodeBu(
  await readFile(new URL('../test/fixtures/abu-dhabi-0001-busa.dat', import.meta.url)),
)
assert.deepEqual(
  [exterior.municipality, exterior.zone, exterior.section],
  ['29254', '0001', '0001'],
)
assert.equal(exterior.elections[0]?.eligible, 91)
assert.equal(exterior.elections[0]?.offices[0]?.turnout, 44)
assert.equal(
  exterior.elections[0]?.offices[0]?.votes.reduce((n, v) => n + v.votes, 0),
  44,
)
console.log(
  'Exterior BU SA: optional detail absent, per-office turnout44 versus root turnout0 passed',
)
const noronha = decodeBu(
  await readFile(new URL('../test/fixtures/noronha-0146-bu.dat', import.meta.url)),
)
const council = noronha.elections.find((e) => e.electionId === '6261')!
const presidency = noronha.elections.find((e) => e.electionId === '6257')!
assert.deepEqual(
  [council.eligible, council.offices[0]?.officeCode, council.offices[0]?.turnout],
  [381, '25', 261],
)
assert.deepEqual([presidency.eligible, presidency.offices[0]?.turnout], [382, 262])
console.log('Noronha council code25 and distinct per-election eligibility/turnout passed')
