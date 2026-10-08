import { readFile } from 'node:fs/promises'
import pg from 'pg'

// Applied in this order, once each; a new migration is appended with the next numeric prefix.
const migrations = ['001-election', '002-areas-parent'] as const

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required')
  // Fail fast when the database is unreachable instead of waiting for the operating system's
  // TCP timeout; idle connections are closed after 30 s.
  return new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  })
}

export async function migrate(pool: pg.Pool) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(202601)')
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    )
    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (row) => row.name,
      ),
    )
    for (const name of migrations) {
      if (applied.has(name)) continue
      await client.query(await readFile(new URL(`./${name}.sql`, import.meta.url), 'utf8'))
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
