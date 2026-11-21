// The app map Gemini drew for each repo, kept on disk so reopening a repo shows it at once.
// It is only redrawn when the engineer asks (Re-read).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { flowKinds, type AppFlow } from '../../shared/gemini.ts'

const fileFor = (dir: string, repoId: number): string => join(dir, `${repoId}.json`)

/** Our own file, but it may be from an older build or hand-edited: check its shape. */
function isAppFlow(value: unknown): value is AppFlow {
  const v = value as Partial<AppFlow> | null
  return (
    Array.isArray(v?.boxes) &&
    Array.isArray(v.links) &&
    v.boxes.every(
      (b) =>
        typeof b?.id === 'string' &&
        typeof b.name === 'string' &&
        (flowKinds as readonly string[]).includes(b.kind) &&
        Array.isArray(b.tables) &&
        Array.isArray(b.paths)
    ) &&
    v.links.every((l) => typeof l?.from === 'string' && typeof l.to === 'string')
  )
}

/** The saved map, or null when there is none or it can't be read. Never throws. */
export async function loadAppFlow(dir: string, repoId: number): Promise<AppFlow | null> {
  try {
    const value: unknown = JSON.parse(await readFile(fileFor(dir, repoId), 'utf8'))
    return isAppFlow(value) ? value : null
  } catch {
    return null
  }
}

/** Write-then-rename, so a crash mid-write never leaves half a map behind. */
export async function saveAppFlow(dir: string, repoId: number, flow: AppFlow): Promise<void> {
  await mkdir(dir, { recursive: true })
  const file = fileFor(dir, repoId)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(flow))
  await rename(tmp, file)
}
