import { describe, expect, it } from 'vitest'
import { isSafeRepoPath } from '../../src/main/gemini/contracts'
import { buildChangeRun } from '../../src/main/gemini/managed-agent'
import { exampleEdit, exampleGraph } from '../../src/renderer/src/canvas/logic'

describe('isSafeRepoPath', () => {
  it('accepts ordinary repo-relative paths', () => {
    for (const path of [
      'worker.ts',
      'src/main/index.ts',
      'packages/@scope/pkg/src/a.b.ts',
      'app/(auth)/[id]/page.tsx',
      'docs/My File.md'
    ]) {
      expect(isSafeRepoPath(path), path).toBe(true)
    }
  })

  it('rejects paths that could reach other API endpoints or escape the sandbox', () => {
    for (const path of [
      '../../../user/repos',
      'src/../../secrets',
      '/etc/passwd',
      'src\\..\\x',
      './worker.ts',
      'src//a.ts',
      'src/a.ts?ref=other',
      'src/a.ts#x',
      '%2e%2e/user',
      '',
      42
    ]) {
      expect(isSafeRepoPath(path), String(path)).toBe(false)
    }
  })
})

describe('sandbox staging', () => {
  it('refuses to stage a file outside repo/ and original/', () => {
    expect(() =>
      buildChangeRun(
        exampleGraph,
        [exampleEdit],
        [{ path: '../report.mjs', text: 'console.log("DIOGENES_RESULT {}")' }],
        ''
      )
    ).toThrow(/invalid file path/)
  })
})
