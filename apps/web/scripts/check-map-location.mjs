import assert from 'node:assert/strict'
import { locationURL, readLocation } from '../src/features/map/map-location.ts'

const origin = 'https://maps.example'
assert.deepEqual(readLocation(new URL(origin)), { countryCode: 'BR', selectionId: null })
for (const [countryCode, type, geoid, stateCode, query] of [
  ['BR', 'state', '35', '35', 'state=35'],
  ['BR', 'municipality', '3550308', '35', 'state=35&municipality=3550308'],
  ['US', 'state', '02', '02', 'state=02'],
  ['US', 'county', '06037', '06', 'state=06&county=06037'],
  ['US', 'place', '3651000', '36', 'state=36&place=3651000'],
  ['US', 'subdivision', '3606150617', '36', 'state=36&subdivision=3606150617'],
]) {
  const id = countryCode === 'BR' ? geoid : `US:${type}:${geoid}`
  const area = { id, countryCode, type, geoid, stateCode }
  const path = locationURL(new URL(`${origin}/br?state=33&municipality=3304557`), countryCode, area)
  assert.equal(path, `/${countryCode.toLowerCase()}?${query}`)
  assert.deepEqual(readLocation(new URL(path, origin)), { countryCode, selectionId: id })
}
assert.deepEqual(readLocation(new URL(`${origin}/us?state=02&municipality=3550308`)), {
  countryCode: 'US',
  selectionId: 'US:state:02',
})
assert.equal(readLocation(new URL(`${origin}/br?municipality=bad&state=35`)).selectionId, '35')
assert.equal(
  locationURL(new URL(`${origin}/br?state=35&municipality=3550308&utm_source=test`), 'US', null),
  '/us?utm_source=test',
)
assert.equal(locationURL(new URL(origin), 'US', null, '/maps/'), '/maps/us')
assert.equal(
  readLocation(new URL(`${origin}/maps/us?state=02`), '/maps/').selectionId,
  'US:state:02',
)
console.log(
  'URL checks passed: country paths, all area levels, leading zeros, invalid parameters, country switching and base paths',
)

assert.equal(
  locationURL(new URL(`${origin}/us?estado=35&municipio=3550308&state=36`), 'US', null),
  '/us',
)
