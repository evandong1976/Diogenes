import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { pinnedBend, verifyRefundRetry } from '../../src/main/verification/refundRetry'

const repoDir = fileURLToPath(new URL('../..', import.meta.url))
const approval = join(repoDir, 'fixtures/refund-retry-approval')
const packetPath = join(approval, 'packet.json')
const trustedDigest = readFileSync(join(approval, 'packet.sha256'), 'utf8')
const baseCommit: string = JSON.parse(readFileSync(packetPath, 'utf8')).baseCommit
// The checked-in fixture is the correct candidate; the baseline is read from its pinned commit.
const correct = (file: string): string =>
  readFileSync(join(repoDir, 'fixtures/refund-retry', file), 'utf8')
const baseline = (file: string): string =>
  spawnSync('git', ['show', `${baseCommit}:fixtures/refund-retry/${file}`], {
    cwd: repoDir,
    encoding: 'utf8'
  }).stdout

function replaceOnce(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`variant edit did not apply: ${from}`)
  return text.replace(from, to)
}

const correctFiles = (): Record<string, string> =>
  Object.fromEntries(
    ['domain.bend', 'reducer.bend', 'PROOF.bend', 'reducer.d.mts', 'retry.ts'].map((f) => [
      f,
      correct(f)
    ])
  )

/** Commits files over the baseline fixture without touching refs, the index or the worktree. */
function candidateCommit(name: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'diogenes-candidate-'))
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(dir, 'index'),
    GIT_AUTHOR_NAME: 'Candidate',
    GIT_AUTHOR_EMAIL: 'candidate@example.invalid',
    GIT_COMMITTER_NAME: 'Candidate',
    GIT_COMMITTER_EMAIL: 'candidate@example.invalid',
    GIT_AUTHOR_DATE: '2026-11-21T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-11-21T00:00:00Z'
  }
  const git = (args: string[], input?: string): string => {
    const r = spawnSync('git', args, { cwd: repoDir, env, input, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  try {
    git(['read-tree', baseCommit])
    for (const [file, text] of Object.entries(files)) {
      const blob = git(['hash-object', '-w', '--stdin'], text)
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},fixtures/refund-retry/${file}`])
    }
    return git(['commit-tree', git(['write-tree']), '-p', baseCommit, '-m', `candidate: ${name}`])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Without the pinned Bend, bend-backed checks stay unknown. With an explicit $BENDTT a valid law
// must pass; otherwise Bend may still find or build a kernel, so a valid law may pass or be unknown.
const bend = pinnedBend()
const bendReady =
  spawnSync(bend, ['version'], { encoding: 'utf8' }).stdout?.trim() === 'bend 2.0.40'
const kernelPinned = Boolean(process.env.BENDTT)

function allowedLaw(expected: 'pass' | 'fail'): string[] {
  if (!bendReady) return ['unknown']
  if (expected === 'fail' || kernelPinned) return [expected]
  return ['pass', 'unknown']
}

const variants = [
  {
    name: 'correct',
    files: correctFiles(),
    expected: { 'native-typecheck': 'pass', 'graph-conformance': 'pass', 'bend-law': 'pass' }
  },
  {
    // Reducer updated, TypeScript boundary left stale: the caller's Attempt3 check cannot compile.
    name: 'type error',
    files: { ...correctFiles(), 'reducer.d.mts': baseline('reducer.d.mts') },
    expected: { 'native-typecheck': 'fail', 'graph-conformance': 'pass', 'bend-law': 'pass' }
  },
  {
    // Type-correct, but the third failure requests a fourth execution.
    name: 'fourth attempt',
    files: {
      ...correctFiles(),
      'reducer.bend': replaceOnce(
        correct('reducer.bend'),
        'case D.SAttempt3{} D.EFailed{D.A3{}}:\n      D.RetryStep{D.SFailed{}, D.NoEffect{}}',
        'case D.SAttempt3{} D.EFailed{D.A3{}}:\n      D.RetryStep{D.SAttempt3{}, D.RunAttempt{D.A3{}}}'
      )
    },
    expected: { 'native-typecheck': 'pass', 'graph-conformance': 'fail', 'bend-law': 'fail' }
  }
] as const

describe('refund retry verification', () => {
  it.each(variants)(
    '$name candidate',
    ({ name, files, expected }) => {
      const candidate = candidateCommit(name, files)
      const report = verifyRefundRetry({ repoDir, packetPath, trustedDigest, candidate, bend })
      if (!report.valid) throw new Error(report.reason)
      console.log(
        `${name} ${candidate}: ${report.obligations.map((o) => `${o.id}=${o.outcome}`).join(' ')}`
      )
      expect(report.candidateSha).toBe(candidate)
      expect(report.packetDigest).toBe(trustedDigest.trim())
      const outcome = (id: string): string | undefined =>
        report.obligations.find((o) => o.id === id)?.outcome
      expect(outcome('native-typecheck')).toBe(expected['native-typecheck'])
      expect(outcome('graph-conformance')).toBe(
        bendReady ? expected['graph-conformance'] : 'unknown'
      )
      expect(allowedLaw(expected['bend-law'])).toContain(outcome('bend-law'))
      for (const o of report.obligations) {
        expect([o.candidateSha, o.packetDigest]).toEqual([candidate, report.packetDigest])
        if (o.outcome === 'fail') expect(o.diagnostic).toBeTruthy()
      }
      if (name === 'fourth attempt' && bendReady) {
        const conformance = report.obligations.find((o) => o.id === 'graph-conformance')
        expect(conformance?.diagnostic).toContain(
          'pair Attempt3/Failed(3): expected Failed / NoEffect, actual Attempt3 / RunAttempt(3)'
        )
        expect(conformance?.diagnostic).toContain('expected attempts [1,2,3], actual [1,2,3,3,3]')
      }
    },
    900_000
  )
})
