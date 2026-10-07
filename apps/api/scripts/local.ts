import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { userInfo } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, parseEnv } from 'node:util'
import { readConfig } from '../src/config.js'
import { createPool, migrate } from '../src/db/index.js'
import { importElection } from '../src/modules/elections/ingestion/import.js'
import { downloadPhotos } from '../src/modules/elections/ingestion/photos.js'
import { atomicWrite } from '../src/modules/elections/ingestion/source.js'

export const repository = fileURLToPath(new URL('../../../', import.meta.url))
const managedMarker = '.datara-managed'
async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return false
  }
}
export async function settings(directory = repository, shell = process.env) {
  const file = join(directory, '.env')
  const text = (await exists(file)) ? await readFile(file, 'utf8') : ''
  const stored = parseEnv(text)
  if (stored.DATABASE_URL && shell.DATABASE_URL && stored.DATABASE_URL !== shell.DATABASE_URL)
    throw new Error('DATABASE_URL differs from .env. Edit .env or unset the shell override.')
  const env = { ...stored, ...shell }
  if (!env.DATABASE_URL) {
    env.LOCAL_POSTGRES_DIR = join(directory, '.data/postgres')
    env.LOCAL_POSTGRES_PORT ??= '55431'
    env.DATABASE_URL = `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:${env.LOCAL_POSTGRES_PORT}/datara`
  }
  env.ELECTION_ARCHIVE_DIR ??= join(directory, '.data/elections')
  env.PHOTO_DIRECTORY ??= join(directory, '.data/public')
  env.PORT ??= '3000'
  env.CORS_ORIGIN ??= 'http://localhost:5173'
  env.ASSET_BASE_URL ??= '/assets'
  readConfig(env)
  return { directory, file, text, stored, env }
}
export async function saveSettings(config: Awaited<ReturnType<typeof settings>>) {
  const keys = [
    'DATABASE_URL',
    'LOCAL_POSTGRES_DIR',
    'LOCAL_POSTGRES_PORT',
    'ELECTION_ARCHIVE_DIR',
    'PHOTO_DIRECTORY',
    'PORT',
    'CORS_ORIGIN',
    'ASSET_BASE_URL',
    'ELECTION_PRESENTATION_FILE',
    'PG_BIN',
  ]
  const added = keys.filter(
    (key) => config.env[key] !== undefined && config.stored[key] === undefined,
  )
  if (!added.length) return
  const text =
    config.text +
    (config.text && !config.text.endsWith('\n') ? '\n' : '') +
    added.map((key) => `${key}=${JSON.stringify(config.env[key])}`).join('\n') +
    '\n'
  if (!config.text && !(await exists(config.file)))
    await writeFile(config.file, text, { flag: 'wx', mode: 0o600 })
  else await atomicWrite(config.file, Buffer.from(text), 0o600)
}
export function allowSetupDatabase(url: string, explicitExternal = false) {
  const parsed = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol))
    throw new Error('DATABASE_URL must use PostgreSQL')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && !explicitExternal)
    throw new Error(
      'Setup will not modify a non-local database. Use --allow-external-database only for an explicitly chosen development database.',
    )
  if (parsed.searchParams.has('host') && !explicitExternal)
    throw new Error('A DATABASE_URL host override requires --allow-external-database.')
}
export async function freePort(port: number) {
  for (const host of ['127.0.0.1', '::1']) {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code ?? ''))
          resolve()
        else
          reject(new Error(`Port ${port} is occupied. Stop its process or edit the port in .env.`))
      })
      server.listen(port, host, () => server.close((error) => (error ? reject(error) : resolve())))
    })
  }
}
async function postgresBin(env: NodeJS.ProcessEnv) {
  let candidates = env.PG_BIN ? [env.PG_BIN] : []
  if (!env.PG_BIN && process.platform === 'darwin') {
    try {
      candidates.push(
        join(
          execFileSync('brew', ['--prefix', 'postgresql@18'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim(),
          'bin',
        ),
      )
    } catch {
      /* PATH remains available without Homebrew. */
    }
  }
  if (!env.PG_BIN) candidates.push(...(env.PATH ?? '').split(delimiter))
  for (const directory of candidates) {
    if (
      !(await exists(join(directory, 'initdb'))) ||
      !(await exists(join(directory, 'pg_ctl'))) ||
      !(await exists(join(directory, 'createdb')))
    )
      continue
    const version = execFileSync(join(directory, 'initdb'), ['--version'], { encoding: 'utf8' })
    if (!/PostgreSQL\) 18\./.test(version)) continue
    return directory
  }
  throw new Error(
    'PostgreSQL 18 tools not found. Install PostgreSQL 18 yourself or supply PG_BIN / an existing DATABASE_URL; setup installs no system packages.',
  )
}
function pgStatus(binary: string, directory: string) {
  try {
    execFileSync(join(binary, 'pg_ctl'), ['-D', directory, 'status'], { stdio: 'ignore' })
    return true
  } catch (error) {
    if ((error as { status?: number }).status === 3 || (error as { status?: number }).status === 4)
      return false
    throw error
  }
}
export async function managedDatabase(
  config: Awaited<ReturnType<typeof settings>>,
  initialize = false,
) {
  const { env } = config
  if (!env.LOCAL_POSTGRES_DIR) return
  const directory = resolve(env.LOCAL_POSTGRES_DIR)
  const port = Number(env.LOCAL_POSTGRES_PORT)
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('LOCAL_POSTGRES_PORT must be 1024..65535')
  const url = new URL(env.DATABASE_URL!)
  if (url.hostname !== '127.0.0.1' || Number(url.port) !== port || url.pathname !== '/datara')
    throw new Error(
      'Managed PostgreSQL settings do not match DATABASE_URL. Remove LOCAL_POSTGRES_DIR/PORT to use an existing database.',
    )
  const binary = await postgresBin(env)
  if (!(await exists(join(directory, managedMarker)))) {
    if (!initialize) throw new Error('Managed database is not initialized. Run pnpm run setup.')
    if (await exists(directory))
      throw new Error(
        'PostgreSQL directory already exists without a Datara ownership marker; it will not be reset. Supply DATABASE_URL or choose a new LOCAL_POSTGRES_DIR.',
      )
    await freePort(port)
    await mkdir(dirname(directory), { recursive: true })
    execFileSync(
      join(binary, 'initdb'),
      ['-D', directory, '-A', 'trust', '--encoding=UTF8', '--no-locale'],
      { stdio: 'ignore' },
    )
    await writeFile(join(directory, managedMarker), 'Datara local development PostgreSQL\n', {
      flag: 'wx',
      mode: 0o600,
    })
  }
  if (!pgStatus(binary, directory)) {
    await freePort(port)
    execFileSync(
      join(binary, 'pg_ctl'),
      [
        '-D',
        directory,
        '-l',
        join(dirname(directory), 'postgres.log'),
        '-o',
        `-h 127.0.0.1 -p ${port}`,
        'start',
      ],
      { stdio: 'inherit' },
    )
  }
  const adminUrl = new URL(url)
  adminUrl.pathname = '/postgres'
  const admin = createPool(adminUrl.toString())
  try {
    const actual = (await admin.query('SHOW data_directory')).rows[0].data_directory
    if (resolve(actual) !== directory)
      throw new Error('The running PostgreSQL instance does not match the managed data directory')
    if (
      initialize &&
      !(await admin.query("SELECT 1 FROM pg_database WHERE datname='datara'")).rowCount
    )
      execFileSync(
        join(binary, 'createdb'),
        ['-h', '127.0.0.1', '-p', String(port), '-U', decodeURIComponent(url.username), 'datara'],
        { stdio: 'inherit' },
      )
  } finally {
    await admin.end()
  }
}
export async function stopDatabase(config: Awaited<ReturnType<typeof settings>>) {
  const directory = config.env.LOCAL_POSTGRES_DIR
  if (!directory) return
  if (!(await exists(join(directory, managedMarker))))
    throw new Error('Refusing to stop an unowned PostgreSQL directory')
  const binary = await postgresBin(config.env)
  if (pgStatus(binary, directory))
    execFileSync(join(binary, 'pg_ctl'), ['-D', directory, '-m', 'fast', 'stop'], {
      stdio: 'inherit',
    })
}
type SetupState = { publicationId?: string; photosPublicationId?: string }
export async function setup(
  directory = repository,
  shell = process.env,
  options: { offline?: boolean; allowExternalDatabase?: boolean } = {},
) {
  const config = await settings(directory, shell)
  allowSetupDatabase(config.env.DATABASE_URL!, options.allowExternalDatabase)
  if (config.env.LOCAL_POSTGRES_DIR) await postgresBin(config.env)
  await mkdir(join(directory, '.data'), { recursive: true })
  await saveSettings(config)
  await managedDatabase(config, true)
  const pool = createPool(config.env.DATABASE_URL)
  const statePath = join(directory, '.data/local-setup.json')
  const state: SetupState = (await exists(statePath))
    ? JSON.parse(await readFile(statePath, 'utf8'))
    : {}
  const persist = () => atomicWrite(statePath, Buffer.from(JSON.stringify(state, null, 2)))
  try {
    await migrate(pool)
    let active = (
      await pool.query(
        "SELECT p.id FROM editions e JOIN publications p ON p.id=e.active_publication_id AND p.status='published' WHERE e.id='BR-2026-1'",
      )
    ).rows[0]?.id as string | undefined
    if (!active) {
      state.publicationId ??= randomUUID()
      await persist()
      const result = await importElection(pool, {
        publicationId: state.publicationId,
        scope: 'pilot',
        archiveDir: config.env.ELECTION_ARCHIVE_DIR!,
        offline: options.offline,
        pilotUfs: ['ac', 'df', 'pe', 'zz'],
        municipalitiesPerUf: 1,
        sectionsPerUf: 2,
      })
      if (result.status !== 'published')
        throw new Error('Initial pilot did not publish; rerun pnpm run setup to resume')
      active = result.publicationId
    } else console.log('Reusing existing published election data')
    if (state.photosPublicationId !== active) {
      const photos = await downloadPhotos(pool, {
        publicationId: active,
        contestId: 'BR-2026-1:6257:1:br',
        limit: 2,
        archiveDir: config.env.ELECTION_ARCHIVE_DIR!,
        photoDirectory: config.env.PHOTO_DIRECTORY!,
        offline: options.offline,
      })
      if (photos.failed) throw new Error('Photo acquisition failed; rerun pnpm run setup to retry')
      state.photosPublicationId = active
      await persist()
      console.log(
        `Representative local photos: ${photos.downloaded} available, ${photos.missing} officially missing`,
      )
    }
    const scope = (await pool.query('SELECT scope FROM publications WHERE id=$1', [active])).rows[0]
      .scope
    console.log(`Local setup ready. Run pnpm dev. Active data scope: ${scope}.`)
    return config
  } finally {
    await pool.end()
  }
}
export async function dev() {
  const config = await settings()
  if (!(await exists(config.file)))
    throw new Error('Local configuration is missing. Run pnpm run setup first.')
  await freePort(Number(config.env.PORT))
  await freePort(5173)
  await managedDatabase(config)
  const pool = createPool(config.env.DATABASE_URL)
  try {
    const active = (
      await pool.query(
        "SELECT 1 FROM editions WHERE id='BR-2026-1' AND active_publication_id IS NOT NULL",
      )
    ).rowCount
    if (!active) throw new Error('No published election data. Run pnpm run setup first.')
  } catch {
    throw new Error('Local database is not ready. Run pnpm run setup first.')
  } finally {
    await pool.end()
  }
  const child = spawn('pnpm', ['exec', 'turbo', 'run', 'dev'], {
    cwd: repository,
    env: config.env,
    stdio: 'inherit',
    detached: true,
  })
  let timer: NodeJS.Timeout | undefined
  const stop = () => {
    if (!child.pid || timer) return
    process.kill(-child.pid, 'SIGTERM')
    timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        /* Already exited. */
      }
    }, 5000)
    timer.unref()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve(signal ? 0 : (code ?? 1)))
    })
    process.exitCode = timer ? 0 : code
  } finally {
    if (timer) clearTimeout(timer)
    await stopDatabase(config)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { offline: { type: 'boolean' }, 'allow-external-database': { type: 'boolean' } },
  })
  if (positionals[0] === 'setup')
    await setup(repository, process.env, {
      offline: values.offline,
      allowExternalDatabase: values['allow-external-database'],
    })
  else if (positionals[0] === 'dev') await dev()
  else if (positionals[0] === 'stop') {
    const config = await settings()
    if (!(await exists(config.file))) throw new Error('No local setup configuration found')
    await stopDatabase(config)
  } else throw new Error('Expected setup, dev or stop')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Local startup failed')
    process.exitCode = 1
  })
