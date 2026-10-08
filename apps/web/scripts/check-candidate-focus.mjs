// Node check of the pure candidate focus rules: node scripts/check-candidate-focus.mjs
// Values from the pilot publication (president, Lula in Porto Walter, Acre and Brazil).
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// The module imports `./format` without an extension, as the bundler resolves it.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !specifier.endsWith('.ts'))
        return nextResolve(`${specifier}.ts`, context)
      throw error
    }
  },
})
const {
  areaVotes,
  candidateTitle,
  comparableKind,
  contributionOf,
  formatFocusPercent,
  inArea,
  LEVEL_BELOW,
  needsDistribution,
  parentAreaId,
  supportOf,
  toArea,
} = await import('../src/features/elections/candidate-focus.ts')

const LULA = 'BR-2026-1:6257:1:br:280002542548'
const FLAVIO = 'BR-2026-1:6257:1:br:280002551544'
const area = (id, level, name, parentId) => ({
  id,
  level,
  name,
  uf: null,
  municipalityCode: null,
  zoneCode: null,
  sectionCode: null,
  featureId: null,
  parentId,
  principalAreaId: null,
})
const share = (numerator, denominator) => ({
  value: (numerator / denominator) * 100,
  numerator,
  denominator,
  basis: 'recordedCandidateVotesSum',
  state: 'available',
})
const row = (id, votes, denominator) => ({
  candidate: { id },
  votes,
  share: share(votes, denominator),
  officialPercentage: null,
  voteDestination: null,
})
function result(target, { kind = 'EA20', state = 'available', denominator, rows = [] }) {
  return {
    area: target,
    state,
    complete: true,
    provenance: state === 'available' ? { sourceKind: kind } : null,
    summary:
      state === 'available'
        ? { candidateVoteDenominator: denominator, shareBasis: 'recordedCandidateVotesSum' }
        : null,
    candidates: rows,
  }
}
const distribution = (denominator) => ({
  items: denominator === undefined ? [] : [{ contribution: { denominator } }],
})

const br = area('br', 'country', 'BRASIL', null)
const ac = area('ac', 'state', 'ACRE', 'br')
const portoWalter = area('ac:01066', 'municipality', 'PORTO WALTER', 'ac')
const zone = area('ac:01066:0004', 'zone', 'Zona 0004', 'ac:01066')
const section = area('ac:01066:0004:0077', 'section', 'Seção 0077', 'ac:01066:0004')
const rioBranco = area('ac:01392', 'municipality', 'RIO BRANCO', 'ac')

// Votes from the /results row, or from /distribution's denominator when the row is not loaded.
const pwResult = result(portoWalter, { denominator: 6296, rows: [row(LULA, 3208, 6296)] })
assert.equal(needsDistribution(pwResult, LULA), false)
assert.equal(needsDistribution(pwResult, FLAVIO), true)
const pw = areaVotes(pwResult, LULA, null)
assert.equal(pw.votes, 3208)
const pwFlavio = areaVotes(pwResult, FLAVIO, distribution(2780))
assert.equal(pwFlavio.votes, 2780)
assert.equal(areaVotes(pwResult, FLAVIO, distribution()).votes, null, 'empty list → unavailable')
assert.equal(
  needsDistribution(result(section, { kind: 'BU', denominator: 300 }), LULA),
  false,
  'sections have no level below',
)
assert.equal(LEVEL_BELOW.country, 'state')
assert.equal(formatFocusPercent(0.00495), '<0,01%')
assert.equal(formatFocusPercent(0), '0,00%')
assert.equal(formatFocusPercent(null), '—')
assert.equal(LEVEL_BELOW.zone, 'section')
assert.equal(LEVEL_BELOW.section, undefined)

// Support equals the row share; without the row it is votes over candidateVoteDenominator.
const support = supportOf(pw)
assert.equal(support.state, 'available')
assert.equal(formatFocusPercent(support.value), '50,95%')
assert.equal(support.numerator, 3208)
assert.equal(support.denominator, 6296)
const flavioSupport = supportOf(pwFlavio)
assert.equal(formatFocusPercent(flavioSupport.value), '44,16%')
assert.equal(flavioSupport.basis, 'recordedCandidateVotesSum')
const zeroBase = supportOf(
  areaVotes(result(portoWalter, { denominator: 0 }), FLAVIO, distribution(0)),
)
assert.equal(zeroBase.state, 'undefined')

// Contribution: votes here over votes in the parent, only with matching source kinds.
const acre = areaVotes(result(ac, { denominator: 469066, rows: [row(LULA, 134770, 469066)] }), LULA)
const brazil = areaVotes(
  result(br, { kind: 'aggregate', denominator: 119300788, rows: [row(LULA, 53879538, 119300788)] }),
  LULA,
)
const toAcre = contributionOf(pw, acre)
assert.equal(formatFocusPercent(toAcre.value), '2,38%')
assert.equal(toAcre.denominator, 134770)
assert.equal(toAcre.basis, 'candidateVotesInSelectedScope')
assert.equal(formatFocusPercent(contributionOf(acre, brazil).value), '0,25%', 'aggregate = EA20')
assert.equal(comparableKind('aggregate'), 'EA20')
const bu = areaVotes(
  result(section, { kind: 'BU', denominator: 200, rows: [row(LULA, 99, 200)] }),
  LULA,
)
const zoneVotes = areaVotes(
  result(zone, { denominator: 6296, rows: [row(LULA, 3208, 6296)] }),
  LULA,
)
const mixed = contributionOf(bu, zoneVotes)
assert.equal(mixed.state, 'unavailable')
assert.match(mixed.reason, /boletim de urna.*totalização; a API não compara as duas/)
assert.equal(formatFocusPercent(contributionOf(zoneVotes, pw).value), '100,00%')
const missing = areaVotes(result(rioBranco, { state: 'unavailable' }), LULA)
assert.equal(supportOf(missing).state, 'unavailable')
assert.equal(supportOf(missing).reason, 'Sem resultado em Rio Branco nesta publicação.')
assert.equal(contributionOf(missing, acre).state, 'unavailable')
assert.equal(contributionOf(pw, missing).reason, 'Sem resultado em Rio Branco nesta publicação.')
const shared = areaVotes(result(section, { state: 'shared' }), LULA)
assert.equal(supportOf(shared).reason, 'Contados junto com a seção principal.')
const emptyParent = areaVotes(result(ac, { denominator: 10, rows: [row(LULA, 0, 10)] }), LULA)
assert.equal(contributionOf(pw, emptyParent).state, 'undefined')

// Parents and labels.
assert.equal(parentAreaId(portoWalter), 'ac')
assert.equal(parentAreaId(br), null)
assert.equal(parentAreaId(area('ac', 'state', 'ACRE', 'region:north')), 'br', 'state → country')
assert.equal(parentAreaId(area('region:north', 'region', 'north', 'br')), 'br')
assert.equal(parentAreaId(area('exterior', 'state', 'Exterior', 'br')), 'br')
assert.equal(inArea(portoWalter), 'em Porto Walter')
assert.equal(inArea(ac), 'no Acre')
assert.equal(inArea(br), 'no Brasil')
assert.equal(inArea(area('ba', 'state', 'BAHIA', 'br')), 'na Bahia')
assert.equal(inArea(area('pe', 'state', 'PERNAMBUCO', 'br')), 'em Pernambuco')
assert.equal(inArea(zone), 'na Zona 0004')
assert.equal(toArea(ac), 'para o Acre')
assert.equal(toArea(portoWalter), 'para Porto Walter')
assert.equal(
  candidateTitle({ displayName: 'LULA', number: '13', party: { abbreviation: 'PT' } }, 'Lula'),
  'Lula (13 · PT)',
)
assert.equal(candidateTitle({ displayName: 'X', number: '101', party: null }, 'X'), 'X (101)')

// Contribution map scope: siblings at the map grain, never wider than the contest.
const { contributionMapScope } = await import('../src/features/elections/election-model.ts')
assert.equal(contributionMapScope('br', 'br', 'municipality'), 'br')
assert.equal(contributionMapScope('br', 'ac', 'municipality'), 'ac')
assert.equal(contributionMapScope('br', 'ac:01066', 'municipality'), 'ac')
assert.equal(contributionMapScope('br', 'ac:01066:0004:0077', 'municipality'), 'ac')
assert.equal(contributionMapScope('br', 'ac', 'state'), 'br')
assert.equal(contributionMapScope('br', 'ac:01066', 'state'), 'br')
assert.equal(contributionMapScope('br', 'zz:29254', 'municipality'), 'exterior')
assert.equal(contributionMapScope('br', 'region:north', 'state'), 'region:north')
assert.equal(contributionMapScope('ac', 'ac:01066', 'state'), 'ac', 'state contest')
assert.equal(contributionMapScope('ac', 'ac:01066:0004', 'municipality'), 'ac')

console.log('Candidate focus checks passed')
