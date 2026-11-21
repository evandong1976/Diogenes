/**
 * Integrated headless refund flow: preview and approve a graph change, hand it to the coding
 * boundary, and verify the returned candidate locally. The coding boundary is a fake that always
 * reports success, so acceptance can only come from the local verdicts.
 *
 * Needs Bend 2.0.40 ($DIOGENES_BEND or PATH) and a built BendTT kernel ($BENDTT) for the passing
 * path. Without them the unavailable-evidence test still runs.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { pinnedBend } from '../../src/main/verification/refundRetry'
import { refundRetryVerifier } from '../../src/main/workflow/verifiers'
import { WorkflowService } from '../../src/main/workflow/service'
import type { CatalogGraph, CatalogPatch } from '../../src/shared/catalog'
import type {
  ApprovedChange,
  CandidateBundle,
  CandidateFile,
  CodingHandoff,
  WorkflowCorrelation
} from '../../src/shared/workflow'
import { FakeGateway, FakeThreads } from './fakes'

const repoDir = fileURLToPath(new URL('../..', import.meta.url))
const root = 'fixtures/refund-retry'
const handFrozen: ApprovedChange = JSON.parse(
  readFileSync(join(repoDir, 'fixtures/refund-retry-approval/packet.json'), 'utf8')
)
const base = handFrozen.baseCommit
const correlation: WorkflowCorrelation = {
  projectId: String(handFrozen.repository.id),
  threadId: 'thread-refund',
  draftId: 'draft-refund',
  proposalId: 'proposal-attempt3'
}

// The draft service's input: the observed binding at the base and the proposed patch.
const baseline: CatalogGraph = {
  ...JSON.parse(
    spawnSync('git', ['show', `${base}:${root}/catalog.json`], { cwd: repoDir, encoding: 'utf8' })
      .stdout
  ),
  commit: { sha: base, ref: base }
}
const patch: CatalogPatch = handFrozen.patch

// Candidates the coding run might return. The checked-in fixture is the correct implementation.
const fixture = (file: string): string => readFileSync(join(repoDir, root, file), 'utf8')
const correct = (): CandidateFile[] =>
  ['domain.bend', 'reducer.bend', 'PROOF.bend', 'reducer.d.mts', 'retry.ts'].map((f) => ({
    path: `${root}/${f}`,
    text: fixture(f)
  }))
const fourthAttempt = (): CandidateFile[] =>
  correct().map((f) =>
    f.path.endsWith('reducer.bend')
      ? {
          ...f,
          text: f.text.replace(
            'case D.SAttempt3{} D.EFailed{D.A3{}}:\n      D.RetryStep{D.SFailed{}, D.NoEffect{}}',
            'case D.SAttempt3{} D.EFailed{D.A3{}}:\n      D.RetryStep{D.SAttempt3{}, D.RunAttempt{D.A3{}}}'
          )
        }
      : f
  )

const bend = pinnedBend()
const proofsReady =
  spawnSync(bend, ['version'], { encoding: 'utf8' }).stdout?.trim() === 'bend 2.0.40' &&
  Boolean(process.env.BENDTT)

const dirs: string[] = []
interface Harness {
  service: WorkflowService
  threads: FakeThreads
  gateway: FakeGateway
  storeDir: string
}
function setup(
  produce: (h: CodingHandoff) => CandidateFile[],
  options: {
    bend?: string
    storeDir?: string
    tamper?: (b: CandidateBundle) => CandidateBundle
  } = {}
): Harness {
  const storeDir = options.storeDir ?? mkdtempSync(join(tmpdir(), 'diogenes-workflow-'))
  if (!options.storeDir) dirs.push(storeDir)
  const threads = new FakeThreads()
  const gateway = new FakeGateway(produce, options.tamper)
  const service = new WorkflowService({
    storeDir,
    repoFor: () => repoDir,
    gateway,
    threads,
    verifiers: [refundRetryVerifier(options.bend ?? bend)]
  })
  return { service, threads, gateway, storeDir }
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const request = { correlation, baseline, patch, approvedBy: 'developer' }

describe.runIf(proofsReady)('refund workflow with local proofs', () => {
  it('rejects a completed fourth-attempt run, corrects it, and accepts the fix', async () => {
    const { service, threads, gateway, storeDir } = setup((h) =>
      h.attempt === 1 ? fourthAttempt() : correct()
    )

    // Preview, then approve. Freezing reproduces the hand-frozen approval's design digests.
    const preview = await service.preview({ baseline, patch })
    expect(preview.ok).toBe(true)
    const approval = await service.approve(request)
    expect(await service.approve(request)).toEqual(approval)
    for (const key of ['beforeDigest', 'afterDigest', 'transitionIds'] as const)
      expect(approval.packet[key]).toEqual(handFrozen[key])
    expect(approval.packet.toolchain.lawSourceDigest).toBe(handFrozen.toolchain.lawSourceDigest)
    expect(approval.packet.correlation).toEqual(correlation)

    // Hand off and steer. The gateway receives the frozen intent and base context.
    let h = await service.startHandoff(approval.approvalId)
    expect(gateway.submitted[0]).toMatchObject({
      approvalId: approval.approvalId,
      baseCommit: base,
      editableRoot: root
    })
    expect(gateway.submitted[0].brief).toContain('attempt.2.failed')
    h = await service.steer(h.handoffId, 'Keep the caller change minimal.')
    expect(h.runs[0].run.events.at(-1)).toMatchObject({ kind: 'steer' })

    // The run says it completed. The local verdict fails it anyway.
    h = await service.refresh(h.handoffId)
    const first = h.runs[0].verdict!
    expect(first).toMatchObject({
      approvalId: approval.approvalId,
      candidateId: h.runs[0].candidate!.candidateId,
      remoteClaim: 'completed',
      overall: 'fail'
    })
    const outcome = (v: typeof first, id: string): string | undefined =>
      v.obligations.find((o) => o.id === id)?.outcome
    expect(outcome(first, 'native-typecheck')).toBe('pass')
    expect(outcome(first, 'graph-conformance')).toBe('fail')
    expect(outcome(first, 'bend-law')).toBe('fail')
    expect(h.stage).toBe('correctable')

    // The design thread gets enough to explain the mismatch and ask for a bounded fix.
    const report = threads.last('verdict')!
    expect(report.correctable).toEqual({
      obligationIds: ['graph-conformance', 'bend-law'],
      attemptsLeft: 2
    })
    const conformance = report.mismatches.find((m) => m.obligationId === 'graph-conformance')!
    expect(conformance.transitionIds).toEqual(['attempt.3.failed'])
    expect(conformance.lines).toContain(
      'pair Attempt3/Failed(3): expected Failed / NoEffect, actual Attempt3 / RunAttempt(3)'
    )
    expect(conformance.lines.join('\n')).toContain('expected attempts [1,2,3], actual [1,2,3,3,3]')

    await expect(
      service.requestCorrection(h.handoffId, {
        obligationIds: ['native-typecheck'],
        instructions: 'x'
      })
    ).rejects.toThrow(/failing obligations/)
    h = await service.requestCorrection(h.handoffId, {
      obligationIds: report.correctable!.obligationIds,
      instructions:
        'attempt.3.failed must end in Failed with NoEffect. The reducer requests a fourth execution instead.'
    })
    const retry = gateway.submitted[1]
    expect(retry).toMatchObject({ approvalId: approval.approvalId, attempt: 2, baseCommit: base })
    expect(retry.correction!.previousCandidateId).toBe(first.candidateId)
    expect(retry.brief).toContain('Correction requested')
    expect(retry.brief).toContain('attempt.3.failed')

    h = await service.refresh(h.handoffId)
    expect(h.stage).toBe('accepted')
    const second = h.runs[1].verdict!
    expect(second.overall).toBe('pass')
    expect(second.obligations.map((o) => o.outcome)).toEqual(['pass', 'pass', 'pass'])
    expect(second.candidateId).not.toBe(first.candidateId)

    // Reopen from disk: the same state, tied to the same approval and candidates.
    const reopened = setup(correct, { storeDir })
    const project = await reopened.service.getProject(correlation.projectId)
    expect(project.approvals.map((a) => a.approvalId)).toEqual([approval.approvalId])
    expect(project.handoffs).toHaveLength(1)
    expect(project.handoffs[0]).toMatchObject({
      stage: 'accepted',
      approvalId: approval.approvalId
    })
    expect(project.handoffs[0].runs.map((r) => r.verdict?.overall)).toEqual(['fail', 'pass'])
    const trailer = spawnSync('git', ['log', '-1', '--format=%B', second.candidateId], {
      cwd: join(storeDir, 'candidates', `${correlation.projectId}.git`),
      encoding: 'utf8'
    }).stdout
    expect(trailer).toContain(`Diogenes-Approval: ${approval.approvalId}`)
  }, 900_000)
})

describe('refund workflow boundaries', () => {
  it('reports missing proof tools as unknown evidence and asks for a decision', async () => {
    const { service, threads } = setup(correct, { bend: '/nonexistent/bend' })
    const approval = await service.approve(request)
    let h = await service.startHandoff(approval.approvalId)
    h = await service.refresh(h.handoffId)
    const verdict = h.runs[0].verdict!
    expect(verdict.overall).toBe('unknown')
    expect(verdict.obligations.find((o) => o.id === 'native-typecheck')?.outcome).toBe('pass')
    for (const id of ['graph-conformance', 'bend-law'])
      expect(verdict.obligations.find((o) => o.id === id)).toMatchObject({
        outcome: 'unknown',
        unknownReason: 'unavailable'
      })
    expect(h.stage).toBe('needs-decision')
    expect(threads.last('decision')).toMatchObject({
      reason: 'missing-evidence',
      options: ['reverify', 'revise-design', 'close']
    })
  }, 120_000)

  it('refuses a candidate that names another approval', async () => {
    const { service } = setup(correct, {
      tamper: (b) => ({ ...b, approvalId: '0'.repeat(64) })
    })
    const approval = await service.approve(request)
    let h = await service.startHandoff(approval.approvalId)
    h = await service.refresh(h.handoffId)
    expect(h.runs[0].candidate).toBeUndefined()
    expect(h.runs[0].candidateRejected).toMatch(/approvalId/)
    expect(h.decision).toMatchObject({ reason: 'candidate-rejected' })
  })
})
