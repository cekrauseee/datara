import { createHash, randomUUID } from 'node:crypto'
import { mkdir, opendir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type pg from 'pg'
import { FetchError, Fetcher } from './fetch.js'
import type { Auxiliary } from './types.js'

export const BASE = 'https://resultados.tse.jus.br/oficial'
export type Source = { id: string; bytes: Buffer; sha256: string; url: string }
type Archived = { bytes: Buffer; sha256: string; collectedAt: string }
export type ArchiveOptions = {
  offline?: boolean
  refresh?: boolean
  fetcher?: Fetcher
  /** Aborts downloads requested by the normalizer (interruption). */
  signal?: AbortSignal
}

export class Archive {
  readonly directory: string
  readonly offline: boolean
  readonly refresh: boolean
  readonly fetcher: Fetcher
  readonly signal?: AbortSignal
  /** With --refresh, references collected from this instant on belong to this invocation. */
  readonly startedAt = Date.now()
  private directories?: Promise<unknown>
  constructor(
    readonly client: pg.PoolClient,
    readonly publicationId: string,
    directory: string,
    options: ArchiveOptions = {},
  ) {
    this.directory = resolve(directory)
    this.offline = options.offline ?? false
    this.refresh = options.refresh ?? false
    this.fetcher = options.fetcher ?? new Fetcher()
    this.signal = options.signal
  }
  async get(url: string, kind: string): Promise<Source> {
    officialUrl(url)
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
    const source = (await this.cached(url)) ?? (await this.download(url, this.signal))
    const id = randomUUID()
    await this.client.query(
      `INSERT INTO source_documents(id,publication_id,url,sha256,archive_path,kind,collected_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        this.publicationId,
        url,
        source.sha256,
        join('sha256', source.sha256),
        kind,
        source.collectedAt,
      ],
    )
    return { id, bytes: source.bytes, sha256: source.sha256, url }
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
  /**
   * Warms the archive for one import unit without touching the database: bytes and URL reference
   * only. For a section auxiliary file it also downloads the selected totalized bulletin. Errors
   * other than acquisition failures are left for the normalizer, which reports them per unit.
   */
  async prefetch(url: string, kind: string, signal?: AbortSignal) {
    if (this.offline) return
    try {
      if (kind !== 'EA18') {
        if (!(await this.usable(url))) await this.download(url, signal)
        return
      }
      const auxiliary = (await this.cached(url)) ?? (await this.download(url, signal))
      const data = JSON.parse(auxiliary.bytes.toString('utf8')) as Auxiliary
      const bulletin = sectionOutcome(url, data).bulletinUrl
      if (bulletin && !(await this.usable(bulletin))) await this.download(bulletin, signal)
    } catch (error) {
      if (error instanceof FetchError || signal?.aborted) throw error
    }
  }
  /** Archived bytes this invocation may use for a URL, verified against their hash. */
  private async cached(url: string): Promise<Archived | undefined> {
    const reference = await this.reference(url)
    if (!reference) return undefined
    const bytes = await readFile(join(this.directory, 'sha256', reference.sha256))
    if (hash(bytes) !== reference.sha256) throw new Error(`Archive checksum mismatch: ${url}`)
    return { bytes, sha256: reference.sha256, collectedAt: reference.collectedAt }
  }
  private async usable(url: string) {
    return Boolean(await this.reference(url))
  }
  private async reference(url: string) {
    let reference: { sha256: string; collectedAt: string }
    try {
      reference = JSON.parse(await readFile(referencePath(this.directory, url), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    }
    if (!/^[a-f0-9]{64}$/.test(reference?.sha256 ?? ''))
      throw new Error(`Invalid archive reference: ${url}`)
    // Refresh ignores earlier acquisitions, but not those made by this invocation's prefetch.
    if (this.refresh && !this.offline && !(Date.parse(reference.collectedAt) >= this.startedAt))
      return undefined
    return reference
  }
  private async download(url: string, signal?: AbortSignal): Promise<Archived> {
    officialUrl(url)
    if (this.offline) throw new Error(`Source is not archived: ${url}`)
    const result = await this.fetcher.get(url, { signal })
    if (!result.ok) throw new Error(`Unexpected missing response for ${url}`)
    this.directories ??= Promise.all([
      mkdir(join(this.directory, 'sha256'), { recursive: true }),
      mkdir(join(this.directory, 'urls'), { recursive: true }),
    ])
    await this.directories
    const collectedAt = new Date().toISOString()
    const sha256 = hash(result.bytes)
    // Complete bytes first, then the URL reference; database rows only ever follow both.
    await atomicWrite(join(this.directory, 'sha256', sha256), result.bytes)
    await atomicWrite(
      referencePath(this.directory, url),
      Buffer.from(JSON.stringify({ url, sha256, collectedAt })),
    )
    return { bytes: result.bytes, sha256, collectedAt }
  }
}

const SECTION_STATUSES = new Map([
  ['totalizada', 'bulletin'],
  // Final official situations without a totalized bulletin: no installation, no count or
  // annulment. Their votes are absent from this source, never zero. "Recebida" (files received,
  // not totalized) is transient and fails like any status that is not final.
  ['não instalada', 'official'],
  ['não apurada', 'official'],
  ['anulada', 'official'],
])
const HASH_STATUSES = new Set(['recebido', 'rejeitado', 'excluído', 'totalizado'])
const status = (value: unknown) =>
  typeof value === 'string' ? value.normalize('NFC').trim().toLocaleLowerCase('pt-BR') : ''
/**
 * Interprets an EA18 section auxiliary file. Section states follow the TSE EA18 domain
 * (Recebida, Não instalada, Não apurada, Anulada, Totalizada) and hash states (Recebido,
 * Rejeitado, Excluído, Totalizado). Only final states are accepted; a section that is merely
 * received, a status without bulletin next to a totalized one, and unknown values fail.
 */
export function sectionOutcome(
  auxUrl: string,
  auxiliary: Auxiliary,
): { officialStatus: string; bulletinUrl?: string } {
  const kind = SECTION_STATUSES.get(status(auxiliary.st))
  if (status(auxiliary.st) === 'recebida')
    throw new Error(`EA18 section is received but not totalized: ${auxUrl}`)
  if (!kind)
    throw new Error(`Unknown EA18 section status ${JSON.stringify(auxiliary.st)}: ${auxUrl}`)
  for (const item of auxiliary.hashes ?? [])
    if (!HASH_STATUSES.has(status(item.st)))
      throw new Error(`Unknown EA18 hash status ${JSON.stringify(item.st)}: ${auxUrl}`)
  const bulletin = bulletinUrl(auxUrl, auxiliary)
  if (kind === 'official') {
    if (bulletin)
      throw new Error(
        `EA18 status ${JSON.stringify(auxiliary.st)} contradicts a totalized BU: ${auxUrl}`,
      )
    return { officialStatus: auxiliary.st }
  }
  if (!bulletin) throw new Error(`Totalized section has no totalized BU: ${auxUrl}`)
  return { officialStatus: auxiliary.st, bulletinUrl: bulletin }
}
/** The bulletin of the single totalized hash, or undefined when no totalized hash has one. */
export function bulletinUrl(auxUrl: string, auxiliary: Auxiliary) {
  const hashes = (auxiliary.hashes ?? []).filter((h) => status(h.st) === 'totalizado')
  if (hashes.length > 1) throw new Error(`Multiple totalized BU hashes: ${auxUrl}`)
  const selected = hashes[0]
  const bu = selected?.arq?.find((a) => a.tp === 'bu' || a.tp === 'busa')
  if (!selected || !bu) return undefined
  if (!/^[a-fA-F0-9]+$/.test(selected.hash) || !/^[\w.-]+$/.test(bu.nm))
    throw new Error('Invalid BU source path')
  return `${auxUrl.slice(0, auxUrl.lastIndexOf('/'))}/${selected.hash}/${bu.nm}`
}
function officialUrl(url: string) {
  if (!url.startsWith(`${BASE}/`)) throw new Error('Only official TSE result URLs are allowed')
}
function referencePath(directory: string, url: string) {
  return join(directory, 'urls', `${hash(Buffer.from(url))}.json`)
}
export function hash(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}
export async function atomicWrite(path: string, bytes: Buffer, mode = 0o666) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, bytes, { mode })
  await rename(temporary, path)
}
/**
 * Removes temporary files left by a process killed between write and rename. Only files older
 * than the threshold are removed, so concurrent writers sharing the archive are unaffected.
 */
export async function removeStaleTemporaryFiles(
  directory: string,
  olderThanMs = 5 * 60_000,
  subdirectories = ['sha256', 'urls', 'photo-urls', 'photo-manifests'],
) {
  let removed = 0
  for (const name of subdirectories) {
    const path = join(resolve(directory), name)
    let entries
    try {
      entries = await opendir(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for await (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue
      const file = join(path, entry.name)
      try {
        if (Date.now() - (await stat(file)).mtimeMs < olderThanMs) continue
        await unlink(file)
        removed++
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  return removed
}
