/**
 * The workflow's `CodingGateway` port implemented by the managed coding gateway.
 *
 * Contract differences it resolves:
 * - The workflow hands over a brief plus the files at the base; the gateway takes a frozen handoff
 *   whose `digest` is the approval ID and whose scope is the approval's editable root.
 * - The gateway returns a `git diff` candidate; the workflow wants full file contents. The diff
 *   is applied to the base commit in a throwaway index of the local repository.
 * - A steer is a follow-up turn in the same managed workspace, allowed once the current turn has
 *   ended. Each turn has its own candidate; only the latest turn's candidate is retrievable.
 * - `cancel` asks the provider to stop and reports the outcome it confirmed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256 } from '../coding/candidate'
import type { CodingRunGateway } from '../coding/gateway'
import type { CodingRunRepository } from '../coding/store'
import { git } from '../workflow/approval'
import { minimalEnv } from '../verification/childEnv'
import type { CodingActivity, CodingRunView } from '../../shared/codingRun'
import type {
  CandidateBundle,
  CodingGateway,
  CodingHandoff,
  CodingRunSnapshot,
  RunEvent,
  RunStatus
} from '../../shared/workflow'

export interface CodingAdapterDeps {
  gateway: CodingRunGateway
  store: CodingRunRepository
  /** Local clone containing the approved base commit. */
  repoFor(projectId: string): string
}

export class ManagedCodingAdapter implements CodingGateway {
  constructor(private readonly deps: CodingAdapterDeps) {}

  async submit(handoff: CodingHandoff): Promise<CodingRunSnapshot> {
    const view = await this.deps.gateway.start({
      handoff: {
        handoffId: handoff.handoffId,
        digest: handoff.approvalId,
        repository: handoff.repository,
        baseCommit: handoff.baseCommit,
        intent: handoff.brief,
        guarantees: [],
        latitude: [],
        scope: handoff.editable,
        context: { threadId: handoff.correlation.threadId }
      },
      files: handoff.workspace.map((f) => ({ path: f.path, content: f.text }))
    })
    return snapshot(view, handoff.approvalId)
  }

  async get(runId: string): Promise<CodingRunSnapshot> {
    const view = await this.deps.gateway.status(runId)
    return snapshot(view, view.handoffDigest)
  }

  async steer(runId: string, message: string): Promise<CodingRunSnapshot> {
    const view = await this.deps.gateway.followUp(runId, message)
    return snapshot(view, view.handoffDigest)
  }

  async cancel(runId: string): Promise<CodingRunSnapshot> {
    const view = await this.deps.gateway.cancel(runId)
    return snapshot(view, view.handoffDigest)
  }

  async retrieveCandidate(runId: string): Promise<CandidateBundle> {
    const view = await this.deps.gateway.status(runId)
    if (view.candidate.status !== 'ready')
      throw new Error(`Run ${runId} has no candidate (${view.candidate.status}).`)
    const input = await this.deps.store.input(runId)
    if (!input) throw new Error(`Run ${runId} has no stored input.`)
    const { candidate } = view.candidate
    if (candidate.provenance.turn !== view.turns.length - 1)
      throw new Error(
        `Run ${runId} candidate is from turn ${candidate.provenance.turn}, not the latest.`
      )
    if (sha256(candidate.patch) !== candidate.patchSha256)
      throw new Error(`Run ${runId} candidate patch does not match its digest.`)
    const repo = this.deps.repoFor(String(input.handoff.repository.id))
    const { files, deleted } = applyPatch(
      repo,
      candidate.baseCommit,
      candidate.patch,
      candidate.files
    )
    return {
      runId,
      handoffId: view.handoffId,
      approvalId: view.handoffDigest,
      baseCommit: candidate.baseCommit,
      files,
      deleted,
      ...(candidate.agentReport && { remoteClaim: candidate.agentReport })
    }
  }
}

/** Applies a diff to `base` in a throwaway index and reads back each touched path. */
function applyPatch(
  repo: string,
  base: string,
  patch: string,
  paths: string[]
): Pick<CandidateBundle, 'files' | 'deleted'> {
  const tmp = mkdtempSync(join(tmpdir(), 'dg-candidate-'))
  const env = minimalEnv({ GIT_INDEX_FILE: join(tmp, 'index') })
  try {
    git(repo, ['read-tree', base], undefined, env)
    git(repo, ['apply', '--cached', '--binary', '-'], patch, env)
    const files: CandidateBundle['files'] = []
    const deleted: string[] = []
    for (const path of paths) {
      const entry = git(repo, ['ls-files', '--stage', '--', path], undefined, env).trim()
      if (!entry) {
        deleted.push(path)
        continue
      }
      const blob = entry.split(/\s+/)[1]
      files.push({ path, text: git(repo, ['cat-file', 'blob', blob], undefined, env) })
    }
    return { files, deleted }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function status(view: CodingRunView): RunStatus {
  switch (view.phase) {
    case 'starting':
      return 'queued'
    case 'running':
    case 'uncertain':
      // An uncertain run may exist remotely; it is only resent on an explicit retry.
      return 'running'
    case 'idle':
      return view.candidate.status === 'ready' ? 'completed' : 'failed'
    case 'failed':
    case 'expired':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
  }
}

function snapshot(view: CodingRunView, approvalId: string): CodingRunSnapshot {
  const latest = view.turns.at(-1)
  const events: RunEvent[] = view.activity.map((a: CodingActivity) => ({
    at: view.updatedAt,
    kind: a.kind === 'command' || a.kind === 'command_output' ? 'tool' : 'message',
    text: a.text,
    ...(a.kind === 'command' && { shell: 'command' as const }),
    ...(a.kind === 'command_output' && { shell: 'output' as const })
  }))
  for (const t of view.turns) {
    if (t.kind === 'follow_up' && t.message)
      events.push({
        at: t.attempts[0]?.requestedAt ?? view.updatedAt,
        kind: 'steer',
        text: t.message
      })
    if (t.error) events.push({ at: t.completedAt ?? view.updatedAt, kind: 'error', text: t.error })
  }
  const error =
    view.phase === 'idle' && view.candidate.status === 'missing'
      ? view.candidate.reason
      : view.phase === 'expired'
        ? 'The managed workspace expired.'
        : view.phase === 'uncertain'
          ? 'The provider request may not have arrived; retry the coding run explicitly.'
          : view.phase === 'cancelled'
            ? `Cancelled (${view.cancellation?.outcome}): ${view.cancellation?.detail}`
            : latest?.error
  return {
    runId: view.runId,
    handoffId: view.handoffId,
    approvalId,
    status: status(view),
    remoteStatus: latest?.providerStatus ?? view.phase,
    events,
    turn: view.turns.length - 1,
    reusable: view.phase === 'idle' && !!view.environmentId,
    ...(view.cancellation && { cancellation: view.cancellation }),
    ...(error && { error })
  }
}
