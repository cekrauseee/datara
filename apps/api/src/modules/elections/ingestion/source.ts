import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type pg from 'pg'

export const BASE = 'https://resultados.tse.jus.br/oficial'
export type Source = { id: string; bytes: Buffer; sha256: string; url: string }
export class Archive {
  readonly directory: string
  constructor(
    readonly client: pg.PoolClient,
    readonly publicationId: string,
    directory: string,
    readonly offline = false,
    readonly refresh = false,
  ) {
    this.directory = resolve(directory)
  }
  async get(url: string, kind: string): Promise<Source> {
    if (!url.startsWith(`${BASE}/`)) throw new Error('Only official TSE result URLs are allowed')
    const existing = await this.client.query(
      'SELECT * FROM source_documents WHERE publication_id=$1 AND url=$2',
      [this.publicationId, url],
    )
    const row = existing.rows[0]
    if (row) {
      const bytes = await readFile(join(this.directory, row.archive_path))
      if (hash(bytes) !== row.sha256) throw new Error(`Archive checksum mismatch: ${url}`)
      return { id: row.id, bytes, sha256: row.sha256, url }
    }
    const referencePath = join(this.directory, 'urls', `${hash(Buffer.from(url))}.json`)
    let cached: { sha256: string; collectedAt: string } | undefined
    if (!this.refresh || this.offline) {
      try {
        cached = JSON.parse(await readFile(referencePath, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    let bytes: Buffer
    let collectedAt = cached?.collectedAt ?? new Date().toISOString()
    if (cached) bytes = await readFile(join(this.directory, 'sha256', cached.sha256))
    else {
      if (this.offline) throw new Error(`Source is not archived: ${url}`)
      // Bounded retries handle transient transport failures, without converting missing files to zero votes.
      let response: Response | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
          if (response.ok || (response.status < 500 && response.status !== 429)) break
        } catch (error) {
          if (attempt === 2) throw error
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
      }
      if (!response?.ok)
        throw new Error(`TSE fetch failed ${response?.status ?? 'network'}: ${url}`)
      bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > 64 * 1024 * 1024) throw new Error('Source exceeds 64 MiB limit')
      collectedAt = new Date().toISOString()
    }
    const sha256 = hash(bytes)
    if (cached && sha256 !== cached.sha256) throw new Error(`Archive checksum mismatch: ${url}`)
    const archivePath = join('sha256', sha256)
    await mkdir(join(this.directory, 'sha256'), { recursive: true })
    await mkdir(join(this.directory, 'urls'), { recursive: true })
    await atomicWrite(join(this.directory, archivePath), bytes)
    await atomicWrite(referencePath, Buffer.from(JSON.stringify({ url, sha256, collectedAt })))
    const id = randomUUID()
    await this.client.query(
      `INSERT INTO source_documents(id,publication_id,url,sha256,archive_path,kind,collected_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, this.publicationId, url, sha256, archivePath, kind, collectedAt],
    )
    return { id, bytes, sha256, url }
  }
  async json<T>(url: string, kind: string): Promise<{ source: Source; data: T }> {
    const source = await this.get(url, kind)
    const data = JSON.parse(source.bytes.toString('utf8')) as T & {
      f?: string
      dg?: string
      hg?: string
    }
    if (data.f !== 'o') throw new Error(`Source is not official: ${url}`)
    await this.client.query('UPDATE source_documents SET generated_at=$2 WHERE id=$1', [
      source.id,
      `${data.dg ?? ''} ${data.hg ?? ''}`.trim() || null,
    ])
    return { source, data }
  }
}
export function hash(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}
export async function atomicWrite(path: string, bytes: Buffer, mode = 0o666) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, bytes, { mode })
  await rename(temporary, path)
}
