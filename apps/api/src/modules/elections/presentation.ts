import { z } from '@hono/zod-openapi'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { hexToOklch, oklchToHex } from './color.js'

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
    // Editorial provenance only; never served.
    note: z.string().optional(),
  })
  .strict()
const Editorial = z
  .object({
    candidates: z.record(z.string(), Override).default({}),
    parties: z.record(z.string(), Override.omit({ photo: true })).default({}),
  })
  .strict()
export type EditorialConfig = z.output<typeof Editorial>
type CandidateKey = { id: string; party_number: string | null }

/** Served only for a candidacy without a party. */
export const NEUTRAL_COLOR = '#64748b'
/** OKLCH L 0.60, C 0.13, hues 20°–335° in 45° steps; indexed by party number modulo 8. */
export const FALLBACK_COLORS = [
  '#c25c5f',
  '#b46d10',
  '#868604',
  '#2c965d',
  '#009298',
  '#2d86c8',
  '#8071c8',
  '#af609f',
] as const

export async function readEditorial(path: string | URL) {
  return Editorial.parse(JSON.parse(await readFile(path, 'utf8')))
}
/** Candidate override, then party color; undefined when neither is configured. */
export function configuredColor(config: EditorialConfig, candidate: CandidateKey) {
  return (
    config.candidates[candidate.id]?.color ??
    (candidate.party_number ? config.parties[candidate.party_number]?.color : undefined)
  )
}
export function fallbackColor(partyNumber: string | null) {
  if (partyNumber === null) return NEUTRAL_COLOR
  return FALLBACK_COLORS[Number(partyNumber) % FALLBACK_COLORS.length] ?? NEUTRAL_COLOR
}
/**
 * k-th shade (k >= 1) for candidacies that would otherwise share a color in one contest: hue
 * rotated by 40° × ceil(k / 2), clockwise for odd k and counterclockwise for even k, OKLCH
 * lightness clamped to [0.56, 0.63] and chroma at least 0.12 before fitting into sRGB.
 */
export function deriveShade(hex: string, k: number) {
  if (!Number.isInteger(k) || k < 1)
    throw new RangeError('deriveShade k must be a positive integer')
  const { L, C, h } = hexToOklch(hex)
  const rotation = 40 * Math.ceil(k / 2) * (k % 2 === 1 ? 1 : -1)
  return oklchToHex({
    L: Math.min(0.63, Math.max(0.56, L)),
    C: Math.max(0.12, C),
    h: (((h + rotation) % 360) + 360) % 360,
  })
}
export function candidatePhotoFile(id: string) {
  return `photos/${createHash('sha256').update(id).digest('hex')}.jpg`
}
export async function loadPresentation(
  path: string | URL,
  assetBaseUrl: string,
  photoDirectory: string,
) {
  const config = await readEditorial(path)
  let files: string[]
  try {
    files = await readdir(join(photoDirectory, 'photos'))
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    files = []
  }
  const available = new Set(files.map((file) => `photos/${file}`))
  return (candidate: CandidateKey & { display_name: string }) => {
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
      color: configuredColor(config, candidate) ?? fallbackColor(candidate.party_number),
      photoUrl: photo ? `${assetBaseUrl}/${photo}` : null,
      partyName: party?.displayName,
    }
  }
}
export type Presentation = Awaited<ReturnType<typeof loadPresentation>>
