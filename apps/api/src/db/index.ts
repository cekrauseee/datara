import { readFile } from 'node:fs/promises'
import pg from 'pg'

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required')
  return new pg.Pool({ connectionString, max: 10 })
}

export async function migrate(pool: pg.Pool) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(202601)')
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    )
    const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [
      '001-election',
    ])
    if (!applied.rowCount) {
      await client.query(await readFile(new URL('./001-election.sql', import.meta.url), 'utf8'))
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', ['001-election'])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
