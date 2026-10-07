import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { saveSettings, settings } from './local.js'

const directory = await mkdtemp(join(tmpdir(), 'datara-settings-check-'))
try {
  const config = await settings(directory, { PORT: '3300' })
  await saveSettings(config)
  assert.equal(config.file, join(directory, 'apps/api/.env'))
  await assert.rejects(stat(join(directory, '.env')), { code: 'ENOENT' })
  const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8')
  const text = await readFile(config.file, 'utf8')
  assert.deepEqual(
    text.split('\n').filter((line) => /^# (?![A-Z_]+=)/.test(line) || !line),
    template.split('\n').filter((line) => /^# (?![A-Z_]+=)/.test(line) || !line),
  )
  const stored = parseEnv(text)
  assert.equal(stored.PORT, '3300')
  assert.equal(stored.DATABASE_URL, config.env.DATABASE_URL)
  assert.equal(stored.LOCAL_POSTGRES_DIR, join(directory, '.data/postgres'))
  assert.ok(text.includes('# Persistent original TSE documents;'))
  assert.ok(text.includes('# ELECTION_PRESENTATION_FILE='))
  assert.equal((await stat(config.file)).mode & 0o777, 0o600)

  await appendFile(config.file, '# User configuration\nUSER_NOTE="preserve this"\n')
  const original = await readFile(config.file, 'utf8')
  await saveSettings(await settings(directory, {}))
  assert.equal(await readFile(config.file, 'utf8'), original)
  await saveSettings(await settings(directory, { PG_BIN: '/custom/postgres/bin' }))
  const updated = await readFile(config.file, 'utf8')
  assert.ok(updated.startsWith(original))
  assert.equal(parseEnv(updated).PG_BIN, '/custom/postgres/bin')
  await assert.rejects(
    settings(directory, { DATABASE_URL: 'postgresql://localhost/other' }),
    /DATABASE_URL differs/,
  )
  console.log('Settings check passed: API path, template preservation, overrides and repeat setup')
} finally {
  await rm(directory, { recursive: true, force: true })
}
