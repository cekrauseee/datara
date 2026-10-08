import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import type pg from 'pg'
import { candidatePhotoFile } from '../presentation.js'
import { FetchError, FetchHaltedError, Fetcher, type NetworkOptions } from './fetch.js'
import { atomicWrite, hash, removeStaleTemporaryFiles } from './source.js'

type PhotoReference = {
  url: string
  collectedAt: string
  sha256: string | null
  status: 'available' | 'missing' | 'failed'
  httpStatus?: number
  error?: string
}
type PhotoRecord = PhotoReference & {
  file: string
  localStatus: 'written' | 'unchanged' | 'preserved' | 'unavailable'
}
export type PhotoOptions = {
  publicationId?: string
  contestId?: string
  limit?: number
  archiveDir: string
  photoDirectory: string
  offline?: boolean
  refresh?: boolean
  network?: NetworkOptions
  progressIntervalMs?: number
  /** Aborting stops scheduling candidates; finished checkpoints and the manifest are kept. */
  signal?: AbortSignal
}
// Optional photos may legitimately be missing, so the consecutive 404/410 guard that protects
// the IP from blocking is looser than for voting sources.
const PHOTO_NETWORK: NetworkOptions = {
  timeoutMs: 30_000,
  maxBytes: 10 * 1024 * 1024,
  missingLimit: 25,
}

export async function downloadPhotos(pool: pg.Pool, options: PhotoOptions) {
  const publication = (
    await pool.query(
      `SELECT p.id FROM publications p JOIN editions e ON e.id=p.edition_id
  WHERE p.status='published' AND e.id='BR-2026-1' AND p.id=COALESCE($1::uuid,e.active_publication_id)`,
      [options.publicationId ?? null],
    )
  ).rows[0]
  if (!publication) throw new Error('Published election dataset not found')
  const pub = publication.id as string
  const archive = resolve(options.archiveDir)
  const directory = resolve(options.photoDirectory)
  const configuration = (
    await pool.query(
      "SELECT archive_path,sha256 FROM source_documents WHERE publication_id=$1 AND kind='EA11'",
      [pub],
    )
  ).rows[0]
  if (!configuration) throw new Error('Publication EA11 provenance not found')
  const bytes = await readFile(join(archive, configuration.archive_path))
  if (hash(bytes) !== configuration.sha256) throw new Error('EA11 archive checksum mismatch')
  const config = JSON.parse(bytes.toString()) as { arq: { tp: string; dir: string }[] }
  const template = config.arq.find((a) => a.tp === 'ft')?.dir
  if (!template) throw new Error('Official photo directory not found in EA11')
  const candidates = await pool.query(
    `SELECT c.id,c.official_id,t.election_id,t.office_code,t.scope_area_id
  FROM candidacies c JOIN contests t ON t.publication_id=c.publication_id AND t.id=c.contest_id
  WHERE c.publication_id=$1 AND ($2::text IS NULL OR c.contest_id=$2) ORDER BY c.id LIMIT $3`,
    [pub, options.contestId ?? null, options.limit ?? null],
  )
  if (options.contestId && !candidates.rowCount)
    throw new Error('Contest has no candidates in this publication')
  await mkdir(join(archive, 'sha256'), { recursive: true })
  await mkdir(join(archive, 'photo-urls'), { recursive: true })
  await mkdir(join(archive, 'photo-manifests'), { recursive: true })
  await mkdir(join(directory, 'photos'), { recursive: true })
  if (!options.offline)
    await removeStaleTemporaryFiles(archive).catch((error) =>
      console.error(`Temporary file cleanup failed: ${error}`),
    )
  const manifestPath = join(archive, 'photo-manifests', `${pub}.json`)
  const manifest = (await readJson<Record<string, PhotoRecord>>(manifestPath)) ?? {}
  const summary = {
    publicationId: pub,
    selected: candidates.rowCount ?? 0,
    downloaded: 0,
    missing: 0,
    failed: 0,
    preservedLocal: 0,
    manifestPath,
  }
  const fetcher = new Fetcher({ ...PHOTO_NETWORK, ...options.network })
  const photo = async (candidate: (typeof candidates.rows)[number]): Promise<PhotoRecord> => {
    const uf = candidate.office_code === '1' ? 'br' : String(candidate.scope_area_id).split(':')[0]!
    const url =
      template
        .replace('<base>', 'https://resultados.tse.jus.br')
        .replace('<ambiente>', 'oficial')
        .replace('<ciclo>', 'ele2026')
        .replace('<cd_eleicao>', candidate.election_id)
        .replace('<uf>', uf) + `/${candidate.official_id}.jpeg`
    if (
      !/^https:\/\/resultados\.tse\.jus\.br\/oficial\/ele2026\/\d+\/fotos\/[a-z]{2}\/\d+\.jpeg$/.test(
        url,
      )
    )
      throw new Error('Invalid official photo URL')
    const referencePath = join(archive, 'photo-urls', `${hash(Buffer.from(url))}.json`)
    const previous = await readJson<PhotoReference>(referencePath)
    let reference = previous
    if (!reference || (!options.offline && (options.refresh || reference.status === 'failed'))) {
      if (options.offline) throw new Error(`Photo source is not archived: ${url}`)
      reference = await acquirePhoto(url, archive, fetcher, options.signal)
      await atomicWrite(referencePath, Buffer.from(JSON.stringify(reference)))
    }
    const file = candidatePhotoFile(candidate.id)
    let localStatus: PhotoRecord['localStatus'] = 'unavailable'
    if (reference.status === 'available') {
      if (!reference.sha256 || !/^[a-f0-9]{64}$/.test(reference.sha256))
        throw new Error('Invalid photo archive hash')
      const image = await readFile(join(archive, 'sha256', reference.sha256))
      if (hash(image) !== reference.sha256)
        throw new Error(`Photo archive checksum mismatch: ${url}`)
      const destination = join(directory, file)
      let local: Buffer | undefined
      try {
        local = await readFile(destination)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (local && hash(local) === reference.sha256) localStatus = 'unchanged'
      else if (local && hash(local) !== previous?.sha256) {
        localStatus = 'preserved'
        summary.preservedLocal++
      } else {
        await atomicWrite(destination, image)
        localStatus = 'written'
      }
      summary.downloaded++
    } else if (reference.status === 'missing') summary.missing++
    else summary.failed++
    return { ...reference, file, localStatus }
  }
  const records: (PhotoRecord | undefined)[] = []
  let next = 0
  let failure: unknown
  const startedAt = performance.now()
  const report = () => {
    const seconds = (performance.now() - startedAt) / 1000
    const done = records.filter(Boolean).length
    console.log(
      JSON.stringify({
        event: 'photos-progress',
        processed: done,
        selected: summary.selected,
        downloaded: summary.downloaded,
        missing: summary.missing,
        failed: summary.failed,
        candidatesPerSecond: seconds > 0 ? Math.round((done / seconds) * 100) / 100 : 0,
        network: fetcher.stats,
      }),
    )
  }
  const progress =
    (options.progressIntervalMs ?? 30_000) > 0
      ? setInterval(report, options.progressIntervalMs ?? 30_000).unref()
      : undefined
  // Workers outnumber network slots so archived photos are processed while downloads wait.
  const worker = async () => {
    while (next < candidates.rows.length && !failure && !options.signal?.aborted) {
      const index = next++
      try {
        records[index] = await photo(candidates.rows[index])
      } catch (error) {
        if (!options.signal?.aborted) failure ??= error
        return
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: fetcher.policy.concurrency * 2 }, worker))
    if (failure) throw failure
  } finally {
    clearInterval(progress)
    // Each URL checkpoint is already durable; a single manifest write avoids quadratic rewrites.
    candidates.rows.forEach((candidate, index) => {
      const record = records[index]
      if (record) manifest[candidate.id] = record
    })
    await atomicWrite(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2)))
  }
  return {
    ...summary,
    ...(options.signal?.aborted
      ? { interrupted: true, processed: records.filter(Boolean).length }
      : {}),
  }
}
async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
async function acquirePhoto(
  url: string,
  archive: string,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<PhotoReference> {
  const reference = () => ({ url, collectedAt: new Date().toISOString(), sha256: null })
  let result
  try {
    result = await fetcher.get(url, { signal, allowMissing: true })
  } catch (error) {
    // Interruptions and a halted fetcher are not facts about this photo; record nothing.
    if (signal?.aborted || error instanceof FetchHaltedError) throw error
    return {
      ...reference(),
      status: 'failed',
      ...(error instanceof FetchError && error.status ? { httpStatus: error.status } : {}),
      error: error instanceof Error ? error.message : String(error),
    }
  }
  if (!result.ok) return { ...reference(), status: 'missing', httpStatus: result.status }
  const image = result.bytes
  if (
    image.length < 4 ||
    image[0] !== 255 ||
    image[1] !== 216 ||
    image[image.length - 2] !== 255 ||
    image[image.length - 1] !== 217
  )
    return { ...reference(), status: 'failed', error: 'Response is not a bounded JPEG' }
  const sha256 = hash(image)
  await atomicWrite(join(archive, 'sha256', sha256), image)
  return { ...reference(), sha256, status: 'available', httpStatus: result.status }
}
