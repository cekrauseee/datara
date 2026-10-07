import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPool } from '../src/db/index.js'
import { allowSetupDatabase, managedDatabase, settings, setup } from './local.js'

if (!process.env.TEST_DATABASE_URL || !process.env.ELECTION_ARCHIVE_DIR)
  throw new Error('TEST_DATABASE_URL and the complete pilot ELECTION_ARCHIVE_DIR are required')
const directory = await mkdtemp(join(tmpdir(), 'datara-local-check-'))
const schema = `local_${randomUUID().replaceAll('-', '')}`
const admin = createPool(process.env.TEST_DATABASE_URL)
const url = new URL(process.env.TEST_DATABASE_URL)
url.searchParams.set('options', `-csearch_path=${schema}`)
const env = {
  DATABASE_URL: url.toString(),
  ELECTION_ARCHIVE_DIR: process.env.ELECTION_ARCHIVE_DIR,
  PHOTO_DIRECTORY: join(directory, 'public'),
  PORT: '3300',
}
const pool = createPool(env.DATABASE_URL)
try {
  assert.throws(() => allowSetupDatabase('postgresql://example.com/datara'), /non-local database/)
  assert.throws(
    () => allowSetupDatabase('postgresql://localhost/datara?host=example.com'),
    /host override/,
  )
  const unowned = join(directory, 'unowned-postgres')
  await mkdir(unowned)
  const unsafe = await settings(directory, {
    DATABASE_URL: 'postgresql://localhost:55431/datara',
    LOCAL_POSTGRES_DIR: unowned,
    LOCAL_POSTGRES_PORT: '55431',
  })
  // Match the managed localhost URL while keeping a deliberately unowned existing directory.
  unsafe.env.DATABASE_URL = 'postgresql://127.0.0.1:55431/datara'
  await assert.rejects(
    managedDatabase(unsafe, true),
    /already exists without a Datara ownership marker/,
  )
  await admin.query(`CREATE SCHEMA ${schema}`)
  await setup(directory, env, { offline: true })
  const before = (await pool.query('SELECT count(*)::int n FROM publications')).rows[0].n
  const active = (await pool.query('SELECT active_publication_id FROM editions')).rows[0]
    .active_publication_id
  await appendFile(join(directory, '.env'), '# User configuration\nUSER_NOTE="preserve this"\n')
  const original = await readFile(join(directory, '.env'), 'utf8')
  await setup(directory, env, { offline: true })
  assert.equal((await pool.query('SELECT count(*)::int n FROM publications')).rows[0].n, before)
  assert.equal(
    (await pool.query('SELECT active_publication_id FROM editions')).rows[0].active_publication_id,
    active,
  )
  assert.equal(await readFile(join(directory, '.env'), 'utf8'), original)
  assert.equal((await stat(join(directory, '.env'))).mode & 0o777, 0o600)
  console.log(
    'Local setup check passed: repeated setup preserves publication/config and rejects unowned/remote targets',
  )
} finally {
  await pool.end()
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await admin.end()
  await rm(directory, { recursive: true, force: true })
}
