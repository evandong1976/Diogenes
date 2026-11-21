/**
 * Owns the workflow from approval through coding, candidate retrieval and local verification.
 * The coding run's completion only makes a candidate ready; required local verdicts decide
 * acceptance. All state is in the store, so a new instance resumes where the last one stopped.
 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { ApprovalError, freezeApproval, previewProposal } from './approval.ts'
import { codingBrief, correctionBrief, steerBrief } from './brief.ts'
import { CandidateRepo } from './candidates.ts'
import { WorkflowStore, type WorkflowRepository } from './store.ts'
import { mismatchesOf, toVerdict, unsupportedVerdict, type LocalVerifier } from './verifiers.ts'
import { editableScope } from '../../shared/workflow'
import type { CatalogPatchResult, RetryBehavior } from '../../shared/catalog'
import type {
  ApprovalRecord,
  ApprovalRequest,
  CodingGateway,
  CodingHandoff,
  CorrectionRequest,
  DecisionOption,
  DecisionReason,
  DesignThreadSink,
  HandoffRecord,
  ProjectWorkflowState,
  RunRecord,
  CodingRunSnapshot,
  ThreadMessage,
  Verdict,
  WorkflowApi
} from '../../shared/workflow'

export interface WorkflowDeps {
  /** Local working directory: candidate repositories, and the file store when `store` is absent. */
  storeDir: string
  /** Durable state. Defaults to the file store under `storeDir`. */
  store?: WorkflowRepository
  /** Local git repository for a project. It must contain the approved base commit. */
  repoFor(projectId: string): string
  gateway: CodingGateway
  threads: DesignThreadSink
  verifiers: LocalVerifier[]
  maxAttempts?: number
  now?: () => Date
}

export class WorkflowError extends Error {}

export class WorkflowService implements WorkflowApi {
  private readonly store: WorkflowRepository
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: WorkflowDeps) {
    this.store = deps.store ?? new WorkflowStore(deps.storeDir)
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString()
  }

  async preview(request: Pick<ApprovalRequest, 'baseline' | 'patch'>): Promise<CatalogPatchResult> {
    return previewProposal(request)
  }

  async approve(request: ApprovalRequest): Promise<ApprovalRecord> {
    const repo = this.deps.repoFor(request.correlation.projectId)
    let frozen
    try {
      frozen = freezeApproval(repo, request)
    } catch (error) {
      if (error instanceof ApprovalError) throw new WorkflowError(error.message)
      throw error
    }
    const existing = await this.store.approval(frozen.approvalId)
    if (existing) return existing
    const record: ApprovalRecord = {
      approvalId: frozen.approvalId,
      correlation: request.correlation,
      approvedAt: this.now(),
      approvedBy: request.approvedBy,
      packet: frozen.packet
    }
    return this.store.putApproval(record, frozen.bytes)
  }

  /**
   * Starts the coding effort for an approval. Idempotent: while a handoff for this approval is
   * open, the same handoff is returned instead of starting a second managed run.
   */
  startHandoff(approvalId: string): Promise<HandoffRecord> {
    return this.locked(`approval:${approvalId}`, () => this.startOnce(approvalId))
  }

  private async startOnce(approvalId: string): Promise<HandoffRecord> {
    const approval = await this.store.approval(approvalId)
    if (!approval) throw new WorkflowError(`Unknown approval ${approvalId}`)
    const open = (await this.store.projectHandoffs(approval.correlation.projectId)).find(
      (h) => h.approvalId === approvalId && h.stage !== 'closed'
    )
    if (open) return open
    const now = this.now()
    const handoff: HandoffRecord = {
      handoffId: `hof-${randomBytes(8).toString('hex')}`,
      approvalId,
      correlation: approval.correlation,
      stage: 'coding',
      maxAttempts: this.deps.maxAttempts ?? 3,
      runs: [],
      undelivered: [],
      createdAt: now,
      updatedAt: now
    }
    return this.locked(handoff.handoffId, () => this.submitRun(handoff))
  }

  refresh(handoffId: string): Promise<HandoffRecord> {
    return this.locked(handoffId, async () => {
      const h = await this.require(handoffId)
      await this.redeliver(h)
      const run = h.runs.at(-1)!
      if (h.stage === 'coding') {
        run.run = await this.deps.gateway.get(run.run.runId)
        const { status } = run.run
        if (status === 'completed') return this.collect(h, run)
        if (status === 'failed' || status === 'cancelled') {
          await this.post(h, { kind: 'run', handoffId, runId: run.run.runId, status })
          return this.decide(h, 'run-failed', run.run.error ?? `Run ${status}`, [
            'retry-run',
            'revise-design',
            'close'
          ])
        }
        return this.save(h)
      }
      // Interrupted between materializing and recording a verdict: verify again.
      if (h.stage === 'verifying' && run.candidate) return this.verify(h, run)
      return h
    })
  }

  /**
   * Directs the coding agent in the same managed workspace. Allowed in any open stage once the
   * current turn has ended; a turn that just ended is collected and verified first, so its
   * candidate is never skipped. The follow-up turn becomes a new attempt of this handoff.
   */
  steer(handoffId: string, message: string): Promise<HandoffRecord> {
    return this.locked(handoffId, async () => {
      let h = await this.require(handoffId)
      if (!message.trim()) throw new WorkflowError('A steer needs a message')
      if (h.stage === 'closed') throw new WorkflowError(`Handoff ${handoffId} is closed`)
      const last = h.runs.at(-1)!
      if (h.stage === 'coding') {
        last.run = await this.deps.gateway.get(last.run.runId)
        if (last.run.status === 'completed') h = await this.collect(h, last)
      }
      if (h.stage === 'verifying')
        throw new WorkflowError(`Handoff ${handoffId} is verifying; refresh it first`)
      const { packet } = (await this.store.approval(h.approvalId))!
      return this.continueRun(h, 'steer', steerBrief(packet, message.trim()), {
        steer: message.trim()
      })
    })
  }

  /**
   * Asks the provider to stop the running turn. The decision records what the provider
   * confirmed; a retry is only offered once the remote work is known to have stopped.
   */
  cancel(handoffId: string): Promise<HandoffRecord> {
    return this.locked(handoffId, async () => {
      const h = await this.requireStage(handoffId, 'coding')
      const run = h.runs.at(-1)!
      run.run = await this.deps.gateway.cancel(run.run.runId)
      const c = run.run.cancellation
      return this.decide(
        h,
        'run-failed',
        `Cancelled by the developer. Provider outcome: ${c?.outcome ?? 'unknown'}. ${c?.detail ?? ''}`.trim(),
        ['retry-run', 'revise-design', 'close']
      )
    })
  }

  requestCorrection(
    handoffId: string,
    request: Pick<CorrectionRequest, 'obligationIds' | 'instructions'>
  ): Promise<HandoffRecord> {
    return this.locked(handoffId, async () => {
      const h = await this.requireStage(handoffId, 'correctable')
      const last = h.runs.at(-1)!
      const verdict = last.verdict!
      const failing = verdict.obligations.filter((o) => o.outcome === 'fail').map((o) => o.id)
      if (
        !request.obligationIds.length ||
        request.obligationIds.some((id) => !failing.includes(id))
      )
        throw new WorkflowError(
          `A correction must name failing obligations of candidate ${verdict.candidateId}: ${failing.join(', ')}`
        )
      if (!request.instructions.trim()) throw new WorkflowError('A correction needs instructions')
      const mismatches = mismatchesOf(verdict, await this.behavior(h)).filter((m) =>
        request.obligationIds.includes(m.obligationId)
      )
      const correction: CorrectionRequest = {
        obligationIds: request.obligationIds,
        instructions: request.instructions.trim(),
        previousCandidateId: verdict.candidateId,
        mismatches
      }
      if (this.attemptsUsed(h) >= h.maxAttempts)
        throw new WorkflowError(`Handoff ${h.handoffId} used all ${h.maxAttempts} attempts`)
      // Continue the same workspace when it is still there; otherwise start a fresh run.
      last.run = await this.deps.gateway.get(last.run.runId)
      if (last.run.reusable) {
        const { packet } = (await this.store.approval(h.approvalId))!
        return this.continueRun(h, 'correction', correctionBrief(packet, correction), {
          correction
        })
      }
      return this.submitRun(h, correction)
    })
  }

  resolveDecision(handoffId: string, option: DecisionOption): Promise<HandoffRecord> {
    return this.locked(handoffId, async () => {
      const h = await this.requireStage(handoffId, 'needs-decision')
      if (!h.decision!.options.includes(option))
        throw new WorkflowError(`${option} is not offered: ${h.decision!.options.join(', ')}`)
      const last = h.runs.at(-1)!
      h.decision = undefined
      switch (option) {
        case 'reverify':
          if (!last.candidate) throw new WorkflowError('There is no candidate to verify again')
          h.stage = 'verifying'
          return this.verify(await this.save(h), last)
        case 'retry-run': {
          // The provider has no idempotency key: never start a second run while the first may
          // still be working remotely.
          last.run = await this.deps.gateway.get(last.run.runId)
          const busy = stillRunning(last.run)
          if (busy) {
            h.decision = (await this.require(handoffId)).decision
            await this.save(h)
            throw new WorkflowError(busy)
          }
          return this.submitRun(h, undefined, 'retry')
        }
        case 'revise-design':
        case 'close':
          h.stage = 'closed'
          return this.save(h)
      }
    })
  }

  async getHandoff(handoffId: string): Promise<HandoffRecord | null> {
    return (await this.store.handoff(handoffId)) ?? null
  }

  async getProject(projectId: string): Promise<ProjectWorkflowState> {
    return {
      projectId,
      approvals: await this.store.projectApprovals(projectId),
      handoffs: await this.store.projectHandoffs(projectId)
    }
  }

  // ------------------------------------------------------------------ internals

  /** Corrections and fresh runs count toward `maxAttempts`; developer steers do not. */
  private attemptsUsed(h: HandoffRecord): number {
    return h.runs.filter((r) => r.origin !== 'steer').length
  }

  /** A follow-up turn in the last run's managed workspace, recorded as a new attempt. */
  private async continueRun(
    h: HandoffRecord,
    origin: 'steer' | 'correction',
    message: string,
    extra: Pick<RunRecord, 'steer' | 'correction'>
  ): Promise<HandoffRecord> {
    const last = h.runs.at(-1)!
    const run = await this.deps.gateway.steer(last.run.runId, message)
    const attempt = h.runs.length + 1
    h.runs.push({ attempt, origin, run, ...extra })
    h.stage = 'coding'
    h.decision = undefined
    await this.save(h)
    await this.post(h, {
      kind: 'run',
      handoffId: h.handoffId,
      runId: run.runId,
      status: run.status,
      detail: `${origin} turn ${run.turn ?? ''} in the same workspace`.trim()
    })
    return h
  }

  private async submitRun(
    h: HandoffRecord,
    correction?: CorrectionRequest,
    origin: RunRecord['origin'] = correction ? 'correction' : 'start'
  ): Promise<HandoffRecord> {
    if (this.attemptsUsed(h) >= h.maxAttempts)
      throw new WorkflowError(`Handoff ${h.handoffId} used all ${h.maxAttempts} attempts`)
    const { packet } = (await this.store.approval(h.approvalId))!
    const attempt = h.runs.length + 1
    const handoff: CodingHandoff = {
      handoffId: h.handoffId,
      approvalId: h.approvalId,
      attempt,
      correlation: h.correlation,
      repository: packet.repository,
      baseCommit: packet.baseCommit,
      brief: codingBrief(packet, correction),
      workspace: (packet.sourceContext ?? []).map(({ path, text }) => ({ path, text })),
      editable: editableScope(packet),
      ...(correction && { correction })
    }
    const run = await this.deps.gateway.submit(handoff)
    if (run.handoffId !== h.handoffId || run.approvalId !== h.approvalId)
      throw new WorkflowError(`Gateway run ${run.runId} does not echo the handoff identity`)
    h.runs.push({ attempt, origin, run, ...(correction && { correction }) })
    h.decision = undefined
    h.stage = 'coding'
    await this.save(h)
    await this.post(h, {
      kind: 'run',
      handoffId: h.handoffId,
      runId: run.runId,
      status: run.status
    })
    return h
  }

  private async collect(h: HandoffRecord, run: RunRecord): Promise<HandoffRecord> {
    const { packet } = (await this.store.approval(h.approvalId))!
    const bundle = await this.deps.gateway.retrieveCandidate(run.run.runId)
    const repo = this.candidates(h)
    const problem = repo.check(bundle, {
      runId: run.run.runId,
      handoffId: h.handoffId,
      approvalId: h.approvalId,
      baseCommit: packet.baseCommit,
      editable: editableScope(packet)
    })
    if (problem) {
      run.candidateRejected = problem
      return this.decide(h, 'candidate-rejected', problem, ['retry-run', 'revise-design', 'close'])
    }
    run.candidate = {
      candidateId: repo.materialize(bundle, run.attempt),
      runId: run.run.runId,
      attempt: run.attempt,
      files: bundle.files.map((f) => f.path),
      deleted: bundle.deleted,
      ...(bundle.remoteClaim && { remoteClaim: bundle.remoteClaim })
    }
    h.stage = 'verifying'
    return this.verify(await this.save(h), run)
  }

  private async verify(h: HandoffRecord, run: RunRecord): Promise<HandoffRecord> {
    const { packet } = (await this.store.approval(h.approvalId))!
    const candidate = run.candidate!
    const ctx = {
      approvalId: h.approvalId,
      candidateId: candidate.candidateId,
      handoffId: h.handoffId,
      runId: candidate.runId,
      remoteClaim: run.run.status,
      verifiedAt: this.now()
    }
    const verifier = this.deps.verifiers.find((v) => v.id === packet.toolchain.verifier)
    const verdict: Verdict = verifier
      ? toVerdict(
          packet,
          await verifier.verify({
            repoDir: this.candidates(h).dir,
            packetPath: await this.store.packetFile(h.approvalId),
            trustedDigest: h.approvalId,
            candidate: candidate.candidateId
          }),
          ctx
        )
      : unsupportedVerdict(packet, ctx)
    run.verdict = verdict

    const failing = verdict.obligations.filter((o) => o.outcome === 'fail').map((o) => o.id)
    const attemptsLeft = h.maxAttempts - this.attemptsUsed(h)
    h.stage =
      verdict.overall === 'pass'
        ? 'accepted'
        : failing.length && attemptsLeft > 0
          ? 'correctable'
          : 'needs-decision'
    await this.save(h)
    await this.post(h, {
      kind: 'verdict',
      handoffId: h.handoffId,
      approvalId: h.approvalId,
      candidateId: candidate.candidateId,
      runId: candidate.runId,
      attempt: run.attempt,
      verdict,
      mismatches: mismatchesOf(verdict, await this.behavior(h)),
      ...(h.stage === 'correctable' && { correctable: { obligationIds: failing, attemptsLeft } })
    })
    if (h.stage !== 'needs-decision') return h
    if (verdict.invalid)
      return this.decide(h, 'candidate-rejected', verdict.invalid, [
        'retry-run',
        'revise-design',
        'close'
      ])
    if (failing.length)
      return this.decide(
        h,
        'attempts-exhausted',
        `Still failing after ${this.attemptsUsed(h)} attempts: ${failing.join(', ')}`,
        ['revise-design', 'close']
      )
    const open = verdict.obligations
      .filter((o) => o.outcome === 'unknown')
      .map((o) => `${o.id} (${o.unknownReason}): ${o.diagnostic ?? 'no verdict'}`)
    return this.decide(h, 'missing-evidence', open.join('\n'), [
      'reverify',
      'revise-design',
      'close'
    ])
  }

  private async decide(
    h: HandoffRecord,
    reason: DecisionReason,
    detail: string,
    options: DecisionOption[]
  ): Promise<HandoffRecord> {
    const attemptsLeft = this.attemptsUsed(h) < h.maxAttempts
    h.decision = {
      kind: 'decision',
      handoffId: h.handoffId,
      approvalId: h.approvalId,
      reason,
      detail,
      options: options.filter((o) => o !== 'retry-run' || attemptsLeft)
    }
    h.stage = 'needs-decision'
    await this.save(h)
    await this.post(h, h.decision)
    return h
  }

  private async post(h: HandoffRecord, message: ThreadMessage): Promise<void> {
    try {
      await this.deps.threads.post(h.correlation.threadId, message, h.correlation)
    } catch {
      h.undelivered.push(message)
      await this.save(h)
    }
  }

  private async redeliver(h: HandoffRecord): Promise<void> {
    const pending = h.undelivered.splice(0)
    for (const message of pending) await this.post(h, message)
    if (pending.length) await this.save(h)
  }

  /** The approved state machine behavior of a refund-path approval; null for catalog changes. */
  private async behavior(h: HandoffRecord): Promise<RetryBehavior | null> {
    const { packet } = (await this.store.approval(h.approvalId))!
    if (packet.kind === 'catalog') return null
    const op = packet.patch.operations[0]
    if (op.type !== 'update' || op.node.kind !== 'stateMachine' || !op.node.properties.behavior)
      throw new WorkflowError('Approval has no state machine behavior')
    return op.node.properties.behavior
  }

  private candidates(h: HandoffRecord): CandidateRepo {
    const { projectId } = h.correlation
    const repo = new CandidateRepo(
      join(this.deps.storeDir, 'candidates', `${projectId}.git`),
      this.deps.repoFor(projectId)
    )
    repo.ensure()
    return repo
  }

  private async save(h: HandoffRecord): Promise<HandoffRecord> {
    h.updatedAt = this.now()
    await this.store.putHandoff(h)
    return h
  }

  private async require(handoffId: string): Promise<HandoffRecord> {
    const h = await this.store.handoff(handoffId)
    if (!h) throw new WorkflowError(`Unknown handoff ${handoffId}`)
    return h
  }

  private async requireStage(
    handoffId: string,
    stage: HandoffRecord['stage']
  ): Promise<HandoffRecord> {
    const h = await this.require(handoffId)
    if (h.stage !== stage)
      throw new WorkflowError(`Handoff ${handoffId} is ${h.stage}, not ${stage}`)
    return h
  }

  /** One command at a time per handoff, so a refresh cannot race a correction. */
  private locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve()
    const next = prior.then(fn, fn)
    this.locks.set(
      key,
      next.catch(() => undefined)
    )
    return next
  }
}

/** Why another run must not start yet, or undefined when the last one is known to have stopped. */
function stillRunning(run: CodingRunSnapshot): string | undefined {
  if (run.status === 'queued' || run.status === 'running')
    return `Run ${run.runId} may still be working remotely (${run.remoteStatus}); cancel it or wait before retrying.`
  const outcome = run.cancellation?.outcome
  if (outcome === 'requested' || outcome === 'unconfirmed')
    return `The provider has not confirmed run ${run.runId} stopped (${outcome}); refresh before retrying.`
  return undefined
}
