import { execFileSync } from 'child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

const script =
  process.env.DG_EXPORT_SCRIPT ?? join(__dirname, '../../src/main/coding/export-candidate.mjs')
const token = 'a'.repeat(32)

let root: string
afterEach(() => root && rmSync(root, { recursive: true, force: true }))

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** Runs the export script on a workspace and returns the patch it wrote. */
function exportPatch(base: string, edited: string, sameStat: boolean): string {
  root = mkdtempSync(join(tmpdir(), 'export-candidate-'))
  put(join(root, '.diogenes/base/src/retry.ts'), base)
  put(join(root, '.diogenes/manifest.json'), JSON.stringify({ sourceDigest: 'digest' }))
  put(join(root, 'repo/src/retry.ts'), edited)
  if (sameStat) {
    // The race on its worst day: identical mtime (to the second, no fraction) and size, so only
    // the content differs. Copies that keep the source mtime, as on Windows, carry it into git.
    const at = 1_700_000_000
    utimesSync(join(root, '.diogenes/base/src/retry.ts'), at, at)
    utimesSync(join(root, 'repo/src/retry.ts'), at, at)
    expect(statSync(join(root, 'repo/src/retry.ts')).mtimeMs).toBe(at * 1000)
  }
  execFileSync('node', [script, token], {
    env: { ...process.env, DIOGENES_WORKSPACE_ROOT: root },
    encoding: 'utf8'
  })
  const report = JSON.parse(readFileSync(join(root, '.diogenes/out/candidate.json'), 'utf8'))
  expect(report.token).toBe(token)
  return Buffer.from(report.patch, 'base64').toString('utf8')
}

describe('export-candidate.mjs', () => {
  it('keeps a same-size edit whose mtime matches the base copy', () => {
    const patch = exportPatch(
      'export const maxAttempts = 1\n',
      'export const maxAttempts = 3\n',
      true
    )
    expect(patch).toContain('-export const maxAttempts = 1')
    expect(patch).toContain('+export const maxAttempts = 3')
  })

  it('exports an empty patch when nothing changed', () => {
    const same = 'export const maxAttempts = 1\n'
    expect(exportPatch(same, same, true)).toBe('')
  })
})
