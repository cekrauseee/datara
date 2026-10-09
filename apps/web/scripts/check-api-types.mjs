// Regenerates the OpenAPI types into .generated/ and compares them with the committed file.
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { format, resolveConfig } from 'prettier'

const web = fileURLToPath(new URL('../', import.meta.url))
const committed = fileURLToPath(
  new URL('../src/features/elections/api-types.generated.ts', import.meta.url),
)
const generated = new URL('../.generated/api-types.generated.ts', import.meta.url)
const run = (command, args) =>
  execFileSync(command, args, { cwd: web, stdio: ['ignore', 'ignore', 'inherit'] })

run('pnpm', [
  '--silent',
  '--filter',
  '@datara/api',
  'openapi:export',
  '../web/.generated/openapi.json',
])
run('pnpm', [
  '--silent',
  'exec',
  'openapi-typescript',
  '.generated/openapi.json',
  '-o',
  '.generated/api-types.generated.ts',
])
const expected = await format(await readFile(generated, 'utf8'), {
  ...(await resolveConfig(committed)),
  filepath: committed,
})
const actual = await readFile(committed, 'utf8').catch(() => '')
if (actual !== expected) {
  console.error(
    'Generated API types are stale. Run `pnpm --filter @datara/web api:types` and commit src/features/elections/api-types.generated.ts.',
  )
  process.exit(1)
}
console.log('Generated API types match the OpenAPI document')
