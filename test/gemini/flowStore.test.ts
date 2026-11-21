import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { loadAppFlow, saveAppFlow } from '../../src/main/gemini/flowStore'
import type { AppFlow } from '../../src/shared/gemini'

const flow: AppFlow = {
  boxes: [{ id: 'a', kind: 'data', name: 'S3', summary: 'Files.', tables: [], paths: [] }],
  links: []
}

test('a saved map comes back for its repo only; junk on disk reads as none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flows-'))
  try {
    expect(await loadAppFlow(dir, 7)).toBeNull()
    await saveAppFlow(join(dir, 'nested'), 7, flow)
    expect(await loadAppFlow(join(dir, 'nested'), 7)).toEqual(flow)
    expect(await loadAppFlow(join(dir, 'nested'), 8)).toBeNull()
    await writeFile(join(dir, '9.json'), '{"boxes":[{"id":"x","kind":"robot"}],"links":[]}')
    expect(await loadAppFlow(dir, 9)).toBeNull()
    await writeFile(join(dir, '10.json'), 'not json')
    expect(await loadAppFlow(dir, 10)).toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
