import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type pg from 'pg'
import { candidatePhotoFile } from '../presentation.js'
import { atomicWrite, hash } from './source.js'

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
  try {
    for (const candidate of candidates.rows) {
      const uf =
        candidate.office_code === '1' ? 'br' : String(candidate.scope_area_id).split(':')[0]!
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
        reference = await acquirePhoto(url, archive)
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
      manifest[candidate.id] = { ...reference, file, localStatus }
    }
  } finally {
    // Each URL checkpoint is already durable; a single manifest write avoids quadratic rewrites.
    await atomicWrite(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2)))
  }
  return summary
}
async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
async function acquirePhoto(url: string, archive: string): Promise<PhotoReference> {
  let response: Response | undefined
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (response.status < 500 && response.status !== 429) break
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
    }
    const reference = { url, collectedAt: new Date().toISOString(), sha256: null }
    if (response?.status === 404 || response?.status === 410)
      return { ...reference, status: 'missing', httpStatus: response.status }
    if (!response?.ok) return { ...reference, status: 'failed', httpStatus: response?.status }
    const image = Buffer.from(await response.arrayBuffer())
    if (
      image.length < 4 ||
      image.length > 10 * 1024 * 1024 ||
      image[0] !== 255 ||
      image[1] !== 216 ||
      image[image.length - 2] !== 255 ||
      image[image.length - 1] !== 217
    )
      return { ...reference, status: 'failed', error: 'Response is not a bounded JPEG' }
    const sha256 = hash(image)
    await atomicWrite(join(archive, 'sha256', sha256), image)
    return { ...reference, sha256, status: 'available', httpStatus: response.status }
  } catch (error) {
    return {
      url,
      collectedAt: new Date().toISOString(),
      sha256: null,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
