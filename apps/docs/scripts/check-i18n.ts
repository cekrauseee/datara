import assert from 'node:assert/strict'

const origin = process.env.DOCS_ORIGIN ?? 'http://localhost:3002'
for (const [language, expected] of [
  ['pt-BR,pt;q=0.9,en;q=0.7', 'pt'],
  ['pt-PT;q=0.2,en-US;q=0.9', 'en'],
  ['pt;q=0,en;q=1', 'en'],
  ['de-DE', 'pt'],
  ['', 'pt'],
]) {
  const response = await fetch(`${origin}/api/first-request?example=1`, {
    headers: language ? { 'Accept-Language': language } : {},
    redirect: 'manual',
  })
  assert.equal(response.status, 307)
  assert.equal(
    new URL(response.headers.get('location')!, origin).href,
    `${origin}/${expected}/api/first-request?example=1`,
  )
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
}
for (const locale of ['pt', 'en']) {
  const response = await fetch(`${origin}/${locale}/api/first-request`, {
    headers: { 'Accept-Language': locale === 'pt' ? 'en-US' : 'pt-BR' },
    redirect: 'manual',
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('location'), null)
  assert.match(await response.text(), new RegExp(`<html lang="${locale}"`))
}
for (const path of ['/api/search', '/favicon.ico', '/_next/static/missing.js', '/sitemap.xml']) {
  const response = await fetch(`${origin}${path}`, { redirect: 'manual' })
  assert.equal(response.headers.get('location'), null, `asset/search redirected: ${path}`)
}
assert.equal((await fetch(`${origin}/pt/not-a-page`)).status, 404)
console.log(
  'Locale negotiation, explicit paths, uncached redirects, asset/search bypass and 404 passed',
)
