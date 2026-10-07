import assert from 'node:assert/strict'
import { access, glob, readFile } from 'node:fs/promises'

const document = JSON.parse(await readFile('.generated/openapi.json', 'utf8'))
const expected = Object.keys(document.paths).sort()
for (const locale of ['en', 'pt']) {
  const paths: string[] = []
  for await (const file of glob(`.generated/reference/**/*.${locale}.mdx`)) {
    const content = await readFile(file, 'utf8')
    assert.ok(
      content.includes(`document="${locale === 'pt' ? 'datara-pt' : 'datara'}"`),
      `Wrong locale document in ${file}`,
    )
    const operations = content.match(/operations=\{(\[[^\n]*\])\}/)
    assert.ok(operations, `Missing OpenAPI operations in ${file}`)
    const entries: { path: string; method: string }[] = JSON.parse(operations[1]!)
    for (const entry of entries) {
      assert.equal(entry.method, 'get')
      paths.push(entry.path)
    }
  }
  assert.deepEqual(paths.sort(), expected, `Missing, extra or duplicate ${locale} references`)
}
await access('.source/server.ts')
console.log(`Generation check passed: ${expected.length} routes in both locales and MDX index`)
