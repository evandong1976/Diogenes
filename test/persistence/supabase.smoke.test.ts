/**
 * End-to-end persistence check against the configured Postgres (Supabase) database.
 *
 * Phase 1 (this process) drives the integrated backend: create a design thread, run a design
 * turn that proposes the refund-retry change, approve it twice (deduplicated), start a managed
 * coding run, collect the candidate and verify it locally, and append a duplicate thread event.
 * Phase 2 runs in a fresh process with fresh service instances and recovers every record from
 * the database, then repeats the approval and the append to show both deduplicate across
 * processes.
 *
 * Provider calls are fakes: the design model is scripted and the managed agent is the in-memory
 * Antigravity fake. The local verifier is real; without Bend its obligations stay `unknown`.
 *
 * Records are scoped to a synthetic project ID (a repository ID no GitHub repository has), so
 * nothing else in the database is read or changed. Skipped unless DIOGENES_DATABASE_URL is set.
 *
 *   pnpm smoke:db
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createBackend, type AgentBackend } from '../../src/main/backend/backend'
import type { ModelClient, Part } from '../../src/main/design/model'
import { openDatabase } from '../../src/main/persistence/db'
import { PgCodingRunStore } from '../../src/main/persistence/coding'
import { PgThreadStore } from '../../src/main/persistence/threads'
import { refundRetryVerifier } from '../../src/main/workflow/verifiers'
import type { CatalogGraph } from '../../src/shared/catalog'
import type { ApprovedChange } from '../../src/shared/workflow'
import { FakeProvider, FakeServer, type AgentTurn } from '../coding/fakeProvider'

const configured = !!process.env.DIOGENES_DATABASE_URL?.trim()
const reopenManifest = process.env.DIOGENES_SMOKE_REOPEN
const thisFile = fileURLToPath(import.meta.url)
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const root = 'fixtures/refund-retry'
const handFrozen: ApprovedChange = JSON.parse(
  readFileSync(join(repoRoot, 'fixtures/refund-retry-approval/packet.json'), 'utf8')
)
const exportScript = readFileSync(join(repoRoot, 'src/main/coding/export-candidate.mjs'), 'utf8')
const MODEL = 'smoke-model'

interface Manifest {
  projectId: string
  repoDir: string
  threadId: string
  proposalId: string
  intentId: string
  approvalId: string
  handoffId: string
  runId: string
  environmentId: string
  interactionId: string
  candidateId: string
  verdictId: string
  stage: string
  overall: string
  lastSeq: number
  draftRevision: number
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A scratch repository holding the refund fixture at its base, bound to a synthetic repo ID. */
function scratchRepo(repositoryId: number): { dir: string; base: string; baseline: CatalogGraph } {
  const dir = mkdtempSync(join(tmpdir(), 'dg-smoke-repo-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'smoke@diogenes.invalid')
  git(dir, 'config', 'user.name', 'Diogenes smoke')
  const tar = execFileSync('git', ['archive', '--format=tar', handFrozen.baseCommit, root], {
    cwd: repoRoot
  })
  execFileSync('tar', ['-x', '-C', dir], { input: tar })
  const catalogPath = join(dir, root, 'catalog.json')
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
  catalog.repository = { id: repositoryId, fullName: 'diogenes-smoke/refund-retry' }
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'smoke base')
  const base = git(dir, 'rev-parse', 'HEAD')
  return { dir, base, baseline: { ...catalog, commit: { sha: base, ref: base } } }
}

/** One proposal of the approved refund change, then a short reply. */
function scriptedModel(): ModelClient {
  const steps: Part[][] = [
    [
      {
        functionCall: {
          id: 'propose-1',
          name: 'propose_graph_edit',
          args: {
            summary: 'Allow a third refund attempt.',
            operations: handFrozen.patch.operations
          }
        }
      }
    ],
    [{ text: 'Proposed a third refund attempt for approval.' }]
  ]
  return {
    async generate() {
      const parts = steps.shift()
      if (!parts) throw new Error('Model script exhausted.')
      return { parts, finishReason: 'STOP' }
    }
  }
}

/** The managed agent writes the checked-in third-attempt implementation and exports it. */
const implementAttempt3: AgentTurn = ({ repo, exportCandidate }) => {
  for (const f of ['domain.bend', 'reducer.bend', 'PROOF.bend', 'reducer.d.mts', 'retry.ts'])
    writeFileSync(join(repo, root, f), readFileSync(join(repoRoot, root, f), 'utf8'))
  exportCandidate()
}

function backend(
  m: { projectId: string; repoDir: string; baseline?: CatalogGraph },
  server: FakeServer
): Promise<AgentBackend> {
  return createBackend({
    dataDir: mkdtempSync(join(tmpdir(), 'dg-smoke-data-')),
    authorizer: {
      async authorize(projectId) {
        if (projectId !== m.projectId) throw new Error(`Not authorized for ${projectId}`)
        return {
          projectId,
          repository: { id: Number(projectId), fullName: 'diogenes-smoke/refund-retry' },
          account: 'smoke-tester'
        }
      }
    },
    model: scriptedModel(),
    models: [MODEL],
    observedCatalog: async () => m.baseline ?? null,
    readSource: async () => null,
    codingProvider: () => new FakeProvider(server),
    exportScript,
    repoFor: () => m.repoDir,
    verifiers: [refundRetryVerifier()],
    migrate: true
  })
}

describe.skipIf(!configured || !!reopenManifest)(
  'Supabase persistence (write, then reopen)',
  () => {
    it('persists the full flow and recovers it from a fresh process', async () => {
      const repositoryId = 9_000_000_000_000 + randomInt(1_000_000)
      const projectId = String(repositoryId)
      const { dir: repoDir, base, baseline } = scratchRepo(repositoryId)
      const server = new FakeServer([implementAttempt3])
      const app = await backend({ projectId, repoDir, baseline }, server)
      try {
        expect(await app.status()).toEqual({ storage: 'postgres', schemaVersion: 1 })

        // Thread: creating the same ID twice returns the same thread.
        const threadId = `thr_${randomUUID()}`
        const thread = await app.threads.create(projectId, {
          kind: 'design',
          title: 'Smoke',
          id: threadId
        })
        expect(await app.threads.create(projectId, { kind: 'design', id: threadId })).toEqual(
          thread
        )
        await expect(app.threads.open(String(repositoryId + 1), threadId)).rejects.toThrow(
          /Not authorized/
        )

        // Design turn on the draft at revision 0 proposes the change.
        await app.design.openProject(projectId)
        const { turn } = await app.design.startTurn({
          projectId,
          threadId,
          model: MODEL,
          graph: { repositoryId, commitSha: base, revision: 0 },
          message: 'Retry a failed refund a third time before failing it.',
          selectedComponentId: 'state-machine:refund-retry'
        })
        expect(turn.status).toBe('awaiting-approval')
        const proposalId = turn.proposalId!

        // Approval compares draft revisions, freezes an immutable packet, and deduplicates.
        const stale = await app.design.approve(projectId, proposalId, 7)
        expect(stale.design).toMatchObject({ ok: false, code: 'stale' })
        const first = await app.design.approve(projectId, proposalId, 0)
        expect(first.approvalError).toBeUndefined()
        expect(first.design).toMatchObject({ ok: true, alreadyApproved: false })
        const again = await app.design.approve(projectId, proposalId, 0)
        expect(again.design).toMatchObject({ ok: true, alreadyApproved: true })
        expect(again.approval!.approvalId).toBe(first.approval!.approvalId)
        const approvalId = first.approval!.approvalId
        expect(first.approval!.approvedBy).toBe('smoke-tester')

        // Managed coding run, candidate and local verdict.
        const started = await app.workflow.startHandoff(projectId, approvalId)
        const runId = started.runs[0].run.runId
        await app.settleRun(runId)
        const handoff = await app.workflow.refresh(projectId, started.handoffId)
        const run = handoff.runs[0]
        expect(run.candidate?.candidateId).toMatch(/^[0-9a-f]{40}$/)
        expect(run.verdict?.candidateId).toBe(run.candidate!.candidateId)
        // Without the pinned Bend the verifier cannot decide: unknown, never pass.
        if (run.verdict!.overall === 'unknown') {
          expect(handoff.stage).toBe('needs-decision')
          expect(run.verdict!.obligations.some((o) => o.unknownReason === 'unavailable')).toBe(true)
        }
        const [verdict] = await app.workflow.verdicts(projectId, started.handoffId)
        const codingView = await app.coding.status(projectId, runId)
        expect(codingView.environmentId).toBeTruthy()

        // Deduplicated append: the same event ID twice stores one event.
        const db = openDatabase()
        try {
          const store = new PgThreadStore(db)
          const event = { id: 'smoke:dup', type: 'user_message' as const, text: 'once' }
          const a = await store.append(projectId, threadId, event)
          const b = await store.append(projectId, threadId, event)
          expect(a.duplicate).toEqual([false])
          expect(b.duplicate).toEqual([true])
          expect(b.thread.lastSeq).toBe(a.thread.lastSeq)
        } finally {
          await db.close()
        }

        const state = await app.design.getProject(projectId)
        const manifest: Manifest = {
          projectId,
          repoDir,
          threadId,
          proposalId,
          intentId: state.intents[0].id,
          approvalId,
          handoffId: started.handoffId,
          runId,
          environmentId: codingView.environmentId!,
          interactionId: codingView.turns.at(-1)!.interactionId!,
          candidateId: run.candidate!.candidateId,
          verdictId: verdict.verdictId,
          stage: handoff.stage,
          overall: run.verdict!.overall,
          lastSeq: (await app.threads.open(projectId, threadId)).lastSeq,
          draftRevision: state.draft!.revision
        }
        const manifestPath = join(mkdtempSync(join(tmpdir(), 'dg-smoke-')), 'manifest.json')
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
        await app.close()

        // Phase 2 in a fresh process. It inherits this process's environment, nothing else.
        const child = spawnSync(
          process.execPath,
          [join(repoRoot, 'node_modules/vitest/vitest.mjs'), 'run', thisFile],
          {
            cwd: repoRoot,
            env: { ...process.env, DIOGENES_SMOKE_REOPEN: manifestPath },
            encoding: 'utf8',
            timeout: 180_000
          }
        )
        expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0)
        expect(child.stdout).toMatch(/1 passed/)
        console.log(
          `smoke manifest: ${manifestPath}\n${JSON.stringify({ ...manifest, repoDir: undefined }, null, 2)}`
        )
      } finally {
        await app.close()
      }
    }, 240_000)
  }
)

describe.skipIf(!configured || !reopenManifest)(
  'Supabase persistence (reopen in a fresh process)',
  () => {
    it('recovers every record with fresh service instances', async () => {
      const m: Manifest = JSON.parse(readFileSync(reopenManifest!, 'utf8'))
      const app = await backend(m, new FakeServer([]))
      const db = openDatabase()
      try {
        // Thread and its events, including the workflow's references.
        const thread = await app.threads.open(m.projectId, m.threadId)
        expect(thread.lastSeq).toBe(m.lastSeq)
        expect(thread.events.map((e) => e.seq)).toEqual(thread.events.map((_, i) => i + 1))
        expect(thread.events.filter((e) => e.id === 'smoke:dup')).toHaveLength(1)
        const refs = thread.events.flatMap((e) => e.refs ?? [])
        expect(refs).toContainEqual({ kind: 'handoff', handoffId: m.handoffId })
        expect(refs).toContainEqual({ kind: 'codingRun', runId: m.runId })
        expect(refs).toContainEqual({ kind: 'verdict', verdictId: m.verdictId })

        // Design draft, turn, proposal and intent.
        const design = await app.design.getProject(m.projectId)
        expect(design.draft!.revision).toBe(m.draftRevision)
        expect(design.proposals.find((p) => p.id === m.proposalId)?.status).toBe('approved')
        expect(design.intents.map((i) => i.id)).toEqual([m.intentId])
        expect(design.turns.some((t) => t.proposalId === m.proposalId)).toBe(true)

        // Approval, handoff, run references, candidate and verdict.
        const workflow = await app.workflow.getProject(m.projectId)
        expect(workflow.approvals.map((a) => a.approvalId)).toEqual([m.approvalId])
        const handoff = (await app.workflow.getHandoff(m.projectId, m.handoffId))!
        expect(handoff.stage).toBe(m.stage)
        expect(handoff.runs[0].run.runId).toBe(m.runId)
        expect(handoff.runs[0].candidate!.candidateId).toBe(m.candidateId)
        expect(handoff.runs[0].verdict!.overall).toBe(m.overall)
        expect(
          (await app.workflow.verdicts(m.projectId, m.handoffId)).map((v) => v.verdictId)
        ).toEqual([m.verdictId])
        const runs = await app.coding.list(m.projectId)
        expect(runs).toMatchObject([{ runId: m.runId, candidate: 'ready' }])
        const stored = (await new PgCodingRunStore(db).forProject(m.projectId).read(m.runId))!
        expect(stored.environmentId).toBe(m.environmentId)
        expect(stored.turns.at(-1)!.interactionId).toBe(m.interactionId)
        const ledger = await db.query<{ candidates: string; verdicts: string; runs: string }>(
          `select (select count(*) from private.dg_candidates where project_id = $1) as candidates,
                (select count(*) from private.dg_verdicts where project_id = $1) as verdicts,
                (select count(*) from private.dg_coding_runs where project_id = $1
                   and environment_id = $2 and last_interaction_id = $3) as runs`,
          [m.projectId, m.environmentId, m.interactionId]
        )
        expect(ledger.rows[0]).toEqual({ candidates: '1', verdicts: '1', runs: '1' })

        // The frozen approval cannot be rewritten.
        await expect(
          db.query(`update private.dg_approvals set approved_by = 'x' where approval_id = $1`, [
            m.approvalId
          ])
        ).rejects.toThrow(/immutable/)

        // Repeats from a new process deduplicate.
        const again = await app.design.approve(m.projectId, m.proposalId, 0)
        expect(again.design).toMatchObject({ ok: true, alreadyApproved: true })
        expect(again.approval!.approvalId).toBe(m.approvalId)
        const dup = await new PgThreadStore(db).append(m.projectId, m.threadId, {
          id: 'smoke:dup',
          type: 'user_message',
          text: 'once'
        })
        expect(dup.duplicate).toEqual([true])
        expect((await app.threads.open(m.projectId, m.threadId)).lastSeq).toBe(m.lastSeq)
      } finally {
        await db.close()
        await app.close()
      }
    }, 180_000)
  }
)
