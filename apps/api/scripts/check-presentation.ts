import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { candidatePhotoFile, loadPresentation } from '../src/modules/elections/presentation.js'
async function check() {
  const dir = await mkdtemp(join(tmpdir(), 'datara-photos-'))
  try {
    await mkdir(join(dir, 'photos'))
    const id = 'BR-2026-1:6257:1:br:280002551544'
    const config = join(dir, 'presentation.json')
    await writeFile(config, JSON.stringify({ candidates: {}, parties: {} }))
    const candidate = { id, display_name: 'Official name', party_number: '13' }
    assert.equal((await loadPresentation(config, '/assets', dir))(candidate).photoUrl, null)
    await writeFile(join(dir, candidatePhotoFile(id)), 'JPEG fixture')
    assert.equal(
      (await loadPresentation(config, '/assets', dir))(candidate).photoUrl,
      `/assets/${candidatePhotoFile(id)}`,
    )
    await writeFile(join(dir, 'photos', 'override.jpg'), 'JPEG override fixture')
    await writeFile(
      config,
      JSON.stringify({
        candidates: {
          [id]: { photo: 'photos/override.jpg', displayName: 'Override', color: '#123456' },
        },
        parties: { 13: { displayName: 'Local party' } },
      }),
    )
    const presentation = (await loadPresentation(config, '/assets', dir))(candidate)
    assert.equal(presentation.photoUrl, '/assets/photos/override.jpg')
    assert.equal(presentation.displayName, 'Override')
    assert.equal(presentation.color, '#123456')
    assert.equal(presentation.partyName, 'Local party')
    console.log('Photo presentation override -> official -> null passed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
check()
