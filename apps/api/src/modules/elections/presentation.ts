import { z } from '@hono/zod-openapi'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const Override = z
  .object({
    displayName: z.string().min(1).optional(),
    color: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .optional(),
    photo: z
      .string()
      .regex(/^photos\/[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)$/)
      .optional(),
  })
  .strict()
const Editorial = z
  .object({
    candidates: z.record(z.string(), Override).default({}),
    parties: z.record(z.string(), Override.omit({ photo: true })).default({}),
  })
  .strict()
export function candidatePhotoFile(id: string) {
  return `photos/${createHash('sha256').update(id).digest('hex')}.jpg`
}
export async function loadPresentation(
  path: string | URL,
  assetBaseUrl: string,
  photoDirectory: string,
) {
  const config = Editorial.parse(JSON.parse(await readFile(path, 'utf8')))
  let files: string[]
  try {
    files = await readdir(join(photoDirectory, 'photos'))
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    files = []
  }
  const available = new Set(files.map((file) => `photos/${file}`))
  return (candidate: { id: string; display_name: string; party_number: string | null }) => {
    const party = candidate.party_number ? config.parties[candidate.party_number] : undefined
    const override = config.candidates[candidate.id]
    const official = candidatePhotoFile(candidate.id)
    const photo =
      override?.photo && available.has(override.photo)
        ? override.photo
        : available.has(official)
          ? official
          : null
    return {
      displayName: override?.displayName ?? candidate.display_name,
      color: override?.color ?? party?.color ?? '#64748b',
      photoUrl: photo ? `${assetBaseUrl}/${photo}` : null,
      partyName: party?.displayName,
    }
  }
}
export type Presentation = Awaited<ReturnType<typeof loadPresentation>>
