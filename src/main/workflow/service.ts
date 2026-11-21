/**
 * Owns the workflow from approval through coding, candidate retrieval and local verification.
 * The coding run's completion only makes a candidate ready; required local verdicts decide
 * acceptance. All state is in the store, so a new instance resumes where the last one stopped.
 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { ApprovalError, freezeApproval, previewProposal } from './approval.ts'
import { codingBrief } from './brief.ts'
import { CandidateRepo } from './candidates.ts'
import { WorkflowStore } from './store.ts'
import { mismatchesOf, toVerdict, unsupportedVerdict, type LocalVerifier } from './verifiers.ts'
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
  ThreadMessage,
  Verdict,
  WorkflowApi
} from '../../shared/workflow'

export interface WorkflowDeps {
  storeDir: string
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
  private readonly store: WorkflowStore
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: WorkflowDeps) {
    this.store = new WorkflowStore(deps.storeDir)
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
    const existing = this.store.approval(frozen.approvalId)
    if (existing) return existing
    this.store.writePacket(frozen.approvalId, frozen.bytes)
    const record: ApprovalRecord = {
      approvalId: frozen.approvalId,
      correlation: request.correlation,
      approvedAt: this.now(),
      approvedBy: request.approvedBy,
      packet: frozen.packet
    }
    this.store.putApproval(record)
    return record
  }

  async startHandoff(approvalId: string): Promise<HandoffRecord> {
    const approval = this.store.approval(approvalId)
    if (!approval) throw new WorkflowError(`Unknown approval ${approvalId}`)
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
      const h = this.require(handoffId)
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

  steer(handoffId: string, message: string): Promise<HandoffRecord> {
    return this.locked(handoffId, async () => {
      const h = this.requireStage(handoffId, 'coding')
      const run = h.runs.at(-1)!
      run.run = await this.deps.gateway.steer(run.run.runId, message)
      return this.save(h)
    })
  }

  cancel(handoffId: string): Promise<HandoffRecord> {
    return this.locked(handoffId, async () => {
      const h = this.requireStage(handoffId, 'coding')
      const run = h.runs.at(-1)!
      run.run = await this.deps.gateway.cancel(run.run.runId)
      return this.decide(h, 'run-failed', 'Cancelled by the developer', [
        'retry-run',
        'revise-design',
        'close'
      ])
    })
  }

  requestCorrection(
    handoffId: string,
    request: Pick<CorrectionRequest, 'obligationIds' | 'instructions'>
  ): Promise<HandoffRecord> {
    return this.locked(handoffId, async () => {
      const h = this.requireStage(handoffId, 'correctable')
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
      const mismatches = mismatchesOf(verdict, this.behavior(h)).filter((m) =>
        request.obligationIds.includes(m.obligationId)
      )
      return this.submitRun(h, {
        obligationIds: request.obligationIds,
        instructions: request.instructions.trim(),
        previousCandidateId: verdict.candidateId,
        mismatches
      })
    })
  }

  resolveDecision(handoffId: string, option: DecisionOption): Promise<HandoffRecord> {
    return this.locked(handoffId, async () => {
      const h = this.requireStage(handoffId, 'needs-decision')
      if (!h.decision!.options.includes(option))
        throw new WorkflowError(`${option} is not offered: ${h.decision!.options.join(', ')}`)
      const last = h.runs.at(-1)!
      h.decision = undefined
      switch (option) {
        case 'reverify':
          if (!last.candidate) throw new WorkflowError('There is no candidate to verify again')
          h.stage = 'verifying'
          return this.verify(this.save(h), last)
        case 'retry-run':
          return this.submitRun(h)
        case 'revise-design':
        case 'close':
          h.stage = 'closed'
          return this.save(h)
      }
    })
  }

  async getHandoff(handoffId: string): Promise<HandoffRecord | null> {
    return this.store.handoff(handoffId) ?? null
  }

  async getProject(projectId: string): Promise<ProjectWorkflowState> {
    const mine = <T extends { correlation: { projectId: string } }>(items: T[]): T[] =>
      items.filter((i) => i.correlation.projectId === projectId)
    return {
      projectId,
      approvals: mine(this.store.approvals()),
      handoffs: mine(this.store.handoffs()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    }
  }

  // ------------------------------------------------------------------ internals

  private async submitRun(
    h: HandoffRecord,
    correction?: CorrectionRequest
  ): Promise<HandoffRecord> {
    if (h.runs.length >= h.maxAttempts)
      throw new WorkflowError(`Handoff ${h.handoffId} used all ${h.maxAttempts} attempts`)
    const { packet } = this.store.approval(h.approvalId)!
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
      editableRoot: packet.bindings.root,
      ...(correction && { correction })
    }
    const run = await this.deps.gateway.submit(handoff)
    if (run.handoffId !== h.handoffId || run.approvalId !== h.approvalId)
      throw new WorkflowError(`Gateway run ${run.runId} does not echo the handoff identity`)
    h.runs.push({ attempt, run, ...(correction && { correction }) })
    h.stage = 'coding'
    this.save(h)
    await this.post(h, {
      kind: 'run',
      handoffId: h.handoffId,
      runId: run.runId,
      status: run.status
    })
    return h
  }

  private async collect(h: HandoffRecord, run: RunRecord): Promise<HandoffRecord> {
    const { packet } = this.store.approval(h.approvalId)!
    const bundle = await this.deps.gateway.retrieveCandidate(run.run.runId)
    const repo = this.candidates(h)
    const problem = repo.check(bundle, {
      runId: run.run.runId,
      handoffId: h.handoffId,
      approvalId: h.approvalId,
      baseCommit: packet.baseCommit,
      editableRoot: packet.bindings.root
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
    return this.verify(this.save(h), run)
  }

  private async verify(h: HandoffRecord, run: RunRecord): Promise<HandoffRecord> {
    const { packet } = this.store.approval(h.approvalId)!
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
          verifier.verify({
            repoDir: this.candidates(h).dir,
            packetPath: this.store.packetPath(h.approvalId),
            trustedDigest: h.approvalId,
            candidate: candidate.candidateId
          }),
          ctx
        )
      : unsupportedVerdict(packet, ctx)
    run.verdict = verdict

    const failing = verdict.obligations.filter((o) => o.outcome === 'fail').map((o) => o.id)
    const attemptsLeft = h.maxAttempts - h.runs.length
    h.stage =
      verdict.overall === 'pass'
        ? 'accepted'
        : failing.length && attemptsLeft > 0
          ? 'correctable'
          : 'needs-decision'
    this.save(h)
    await this.post(h, {
      kind: 'verdict',
      handoffId: h.handoffId,
      approvalId: h.approvalId,
      candidateId: candidate.candidateId,
      runId: candidate.runId,
      attempt: run.attempt,
      verdict,
      mismatches: mismatchesOf(verdict, this.behavior(h)),
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
        `Still failing after ${h.runs.length} attempts: ${failing.join(', ')}`,
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
    const attemptsLeft = h.runs.length < h.maxAttempts
    h.decision = {
      kind: 'decision',
      handoffId: h.handoffId,
      approvalId: h.approvalId,
      reason,
      detail,
      options: options.filter((o) => o !== 'retry-run' || attemptsLeft)
    }
    h.stage = 'needs-decision'
    this.save(h)
    await this.post(h, h.decision)
    return h
  }

  private async post(h: HandoffRecord, message: ThreadMessage): Promise<void> {
    try {
      await this.deps.threads.post(h.correlation.threadId, message)
    } catch {
      h.undelivered.push(message)
      this.save(h)
    }
  }

  private async redeliver(h: HandoffRecord): Promise<void> {
    const pending = h.undelivered.splice(0)
    for (const message of pending) await this.post(h, message)
    if (pending.length) this.save(h)
  }

  private behavior(h: HandoffRecord): RetryBehavior {
    const op = this.store.approval(h.approvalId)!.packet.patch.operations[0]
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

  private save(h: HandoffRecord): HandoffRecord {
    h.updatedAt = this.now()
    this.store.putHandoff(h)
    return h
  }

  private require(handoffId: string): HandoffRecord {
    const h = this.store.handoff(handoffId)
    if (!h) throw new WorkflowError(`Unknown handoff ${handoffId}`)
    return h
  }

  private requireStage(handoffId: string, stage: HandoffRecord['stage']): HandoffRecord {
    const h = this.require(handoffId)
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
