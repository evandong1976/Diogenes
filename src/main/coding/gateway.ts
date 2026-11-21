import { randomBytes } from 'crypto'
import type {
  CodingActivity,
  CodingRunApi,
  CodingRunSummary,
  CodingRunTurn,
  CodingRunView,
  StartCodingRun
} from '../../shared/codingRun'
import {
  candidatePath,
  exportCommand,
  parseCandidate,
  sourceDigest,
  stagedSources,
  validateStart,
  workspaceRoot
} from './candidate'
import {
  isActive,
  isFinished,
  ProviderError,
  type CreateTurn,
  type ManagedAgentProvider,
  type ProviderInteraction
} from './provider'
import type { CodingRunStore } from './store'

const activityLimit = 200
const textLimit = 4_000

export interface GatewayOptions {
  store: CodingRunStore
  provider: ManagedAgentProvider
  /** Source of `export-candidate.mjs`, staged into every new workspace. */
  exportScript: string
  now?: () => Date
}

/**
 * Owns the lifecycle of managed coding runs. Every state change is persisted before the next
 * provider call, so a restart can always tell what was sent and what is still unknown.
 */
export class CodingRunGateway implements CodingRunApi {
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly now: () => Date

  constructor(private readonly options: GatewayOptions) {
    this.now = options.now ?? (() => new Date())
  }

  async start(input: StartCodingRun): Promise<CodingRunView> {
    validateStart(input.handoff, input.files)
    stagedSources(input.files, this.options.exportScript) // size limits, before anything is saved
    const at = this.stamp()
    const { handoff } = input
    const run: CodingRunView = {
      runId: `run_${randomBytes(16).toString('hex')}`,
      handoffId: handoff.handoffId,
      handoffDigest: handoff.digest,
      baseCommit: handoff.baseCommit,
      phase: 'starting',
      createdAt: at,
      updatedAt: at,
      turns: [newTurn(0, 'start')],
      activity: [],
      candidate: { status: 'none' },
      context: handoff.context
    }
    await this.options.store.create(run, input)
    this.dispatch(run.runId)
    return run
  }

  async status(runId: string): Promise<CodingRunView> {
    return this.withRun(runId, async (run) => {
      if (run.phase === 'running') await this.refresh(run)
      return run
    })
  }

  async reopen(runId: string): Promise<CodingRunView> {
    return this.withRun(runId, async (run) => {
      const turn = latest(run)
      const attempt = turn.attempts.at(-1)
      if (run.phase === 'starting' && !this.inflight.has(runId)) {
        // The app stopped between saving the attempt and hearing back from the provider.
        if (attempt && !attempt.interactionId && !attempt.error) {
          attempt.error = 'Diogenes stopped before the provider replied.'
        }
        run.phase = 'uncertain'
      } else if (run.phase === 'running') {
        await this.refresh(run)
      } else if (run.phase === 'idle' && run.environmentId) {
        const env = await this.options.provider
          .environmentStatus(run.environmentId)
          .catch(() => null)
        if (env === 'expired' || env === 'gone') run.phase = 'expired'
      }
      return run
    })
  }

  async followUp(runId: string, message: string): Promise<CodingRunView> {
    if (typeof message !== 'string' || !message.trim()) throw new Error('Direction is empty.')
    const view = await this.withRun(runId, async (run) => {
      if (run.phase !== 'idle') {
        throw new Error(`The run is ${run.phase}; it can take direction once the turn finishes.`)
      }
      const turn = newTurn(run.turns.length, 'follow_up')
      turn.message = message.trim()
      run.turns.push(turn)
      run.phase = 'starting'
      return run
    })
    this.dispatch(runId)
    return view
  }

  async retry(runId: string): Promise<CodingRunView> {
    const view = await this.withRun(runId, async (run) => {
      if (run.phase !== 'uncertain') throw new Error(`Only an uncertain run can be retried.`)
      run.phase = 'starting'
      return run
    })
    this.dispatch(runId)
    return view
  }

  async list(): Promise<CodingRunSummary[]> {
    const runs = await this.options.store.list()
    return runs
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((r) => ({
        runId: r.runId,
        handoffId: r.handoffId,
        phase: r.phase,
        updatedAt: r.updatedAt,
        baseCommit: r.baseCommit,
        candidate: r.candidate.status
      }))
  }

  /** Resolves once any provider create call for this run has been recorded. */
  async settle(runId: string): Promise<void> {
    await this.inflight.get(runId)
  }

  private dispatch(runId: string): void {
    const work = this.send(runId)
      .catch((error) =>
        // A local failure (disk, missing input). Keep it visible on the run instead of throwing
        // into a promise nobody awaits. `uncertain` because the create may already have been sent.
        this.withRun(runId, async (run) => {
          latest(run).error = `Diogenes failed to send this turn: ${(error as Error).message}`
          run.phase = 'uncertain'
          return run
        }).catch(() => undefined)
      )
      .then(() => undefined)
      .finally(() => this.inflight.delete(runId))
    this.inflight.set(runId, work)
  }

  /** Records one create attempt for the latest turn, sends it, and records the outcome. */
  private async send(runId: string): Promise<void> {
    const input = await this.options.store.input(runId)
    if (!input) throw new Error('Coding run input is missing.')
    let request: CreateTurn | undefined
    await this.withRun(runId, async (run) => {
      const turn = latest(run)
      turn.attempts.push({ requestedAt: this.stamp() })
      request = this.request(run, input, turn)
      return run
    })

    let interaction: ProviderInteraction
    try {
      interaction = await this.options.provider.create(request!)
    } catch (error) {
      await this.withRun(runId, async (run) => {
        const turn = latest(run)
        const message = error instanceof Error ? error.message : String(error)
        turn.attempts.at(-1)!.error = message
        const kind = error instanceof ProviderError ? error.kind : 'uncertain'
        if (kind === 'uncertain') {
          run.phase = 'uncertain'
        } else if (kind === 'gone') {
          turn.error = message
          run.phase = 'expired'
        } else {
          turn.error = message
          run.phase = turn.index === 0 ? 'failed' : 'idle'
        }
        return run
      })
      return
    }

    await this.withRun(runId, async (run) => {
      const turn = latest(run)
      turn.attempts.at(-1)!.interactionId = interaction.id
      turn.interactionId = interaction.id
      run.environmentId ??= interaction.environmentId
      run.phase = 'running'
      await this.apply(run, turn, interaction)
      return run
    })
  }

  private request(run: CodingRunView, input: StartCodingRun, turn: CodingRunTurn): CreateTurn {
    const finish = `When you are done, run exactly this command and confirm it printed DIOGENES_CANDIDATE_WRITTEN:\n${exportCommand(turn.exportToken)}`
    if (turn.kind === 'start') {
      const { handoff } = input
      const list = (items: string[]): string =>
        items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none)'
      return {
        sources: stagedSources(input.files, this.options.exportScript),
        input: [
          `Implement an approved design change in ${workspaceRoot}.`,
          `It holds the in-scope files of ${handoff.repository.fullName} at commit ${handoff.baseCommit}. Other files are not supplied.`,
          '',
          'Requested behavior:',
          handoff.intent,
          '',
          'Guarantees that must hold:',
          list(handoff.guarantees),
          '',
          'Decisions you may make yourself:',
          list(handoff.latitude),
          '',
          'Change only these paths:',
          list(handoff.scope),
          ...(handoff.acceptance
            ? ['', `Check your work by running, from ${workspaceRoot}:`, handoff.acceptance.command]
            : []),
          '',
          'Do not modify /workspace/.diogenes.',
          finish
        ].join('\n')
      }
    }
    const previous = run.turns
      .slice(0, turn.index)
      .reverse()
      .find((t) => t.interactionId)?.interactionId
    return {
      previousInteractionId: previous,
      environmentId: run.environmentId,
      input: [
        'Direction from the developer for the same change:',
        turn.message ?? '',
        '',
        'Keep the guarantees and path limits from the original task.',
        finish
      ].join('\n')
    }
  }

  private async refresh(run: CodingRunView): Promise<void> {
    const turn = latest(run)
    if (!turn.interactionId) return
    let interaction: ProviderInteraction
    try {
      interaction = await this.options.provider.get(turn.interactionId)
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'gone') {
        turn.error = 'The provider no longer has this interaction.'
        run.phase = 'expired'
      }
      return // transient: keep the last known state
    }
    await this.apply(run, turn, interaction)
  }

  private async apply(
    run: CodingRunView,
    turn: CodingRunTurn,
    interaction: ProviderInteraction
  ): Promise<void> {
    turn.providerStatus = interaction.status
    run.environmentId ??= interaction.environmentId
    run.activity = [
      ...run.activity.filter((a) => a.turn !== turn.index),
      ...interaction.steps.map((s): CodingActivity => ({
        turn: turn.index,
        kind: s.type,
        text: s.text.slice(0, textLimit)
      }))
    ].slice(-activityLimit)

    if (isActive(interaction.status)) {
      run.phase = 'running'
      return
    }
    if (!isFinished(interaction.status)) {
      turn.error = `The provider ended the turn with status ${interaction.status}.`
      turn.completedAt = this.stamp()
      run.phase = turn.index === 0 ? 'failed' : 'idle'
      return
    }
    await this.retrieve(run, turn, interaction)
  }

  /** Downloads the turn's candidate. A transient failure leaves the run `running` to retry. */
  private async retrieve(
    run: CodingRunView,
    turn: CodingRunTurn,
    interaction: ProviderInteraction
  ): Promise<void> {
    const { provider } = this.options
    const settle = (): void => {
      turn.completedAt = this.stamp()
      run.phase = 'idle'
    }
    if (!run.environmentId) {
      run.candidate = { status: 'missing', reason: 'The provider returned no environment.' }
      return settle()
    }
    const input = await this.options.store.input(run.runId)
    if (!input) throw new Error('Coding run input is missing.')
    let file: string
    try {
      file = await provider.readFile(run.environmentId, candidatePath)
    } catch (error) {
      if (!(error instanceof ProviderError) || error.kind !== 'gone') return
      const env = await provider.environmentStatus(run.environmentId).catch(() => null)
      if (env === null) return
      if (env !== 'active') {
        run.candidate = { status: 'missing', reason: 'The workspace expired before retrieval.' }
        turn.completedAt = this.stamp()
        run.phase = 'expired'
        return
      }
      run.candidate = { status: 'missing', reason: 'The agent did not export a candidate.' }
      return settle()
    }
    const parsed = parseCandidate(file, {
      token: turn.exportToken,
      sourceDigest: sourceDigest(input.files),
      scope: input.handoff.scope
    })
    if (!parsed.ok) {
      run.candidate = { status: 'missing', reason: parsed.reason }
      return settle()
    }
    const report = interaction.steps.filter((s) => s.type === 'text').at(-1)?.text
    run.candidate = {
      status: 'ready',
      candidate: {
        runId: run.runId,
        handoffId: run.handoffId,
        handoffDigest: run.handoffDigest,
        baseCommit: run.baseCommit,
        patch: parsed.patch,
        patchSha256: parsed.patchSha256,
        files: parsed.files,
        provenance: {
          provider: 'antigravity',
          agent: provider.agent,
          turn: turn.index,
          interactionId: interaction.id,
          environmentId: run.environmentId,
          sourceDigest: sourceDigest(input.files),
          retrievedAt: this.stamp()
        },
        agentReport: report?.slice(0, textLimit)
      }
    }
    settle()
  }

  /** Serializes load-modify-save for one run. */
  private async withRun(
    runId: string,
    fn: (run: CodingRunView) => Promise<CodingRunView>
  ): Promise<CodingRunView> {
    const previous = this.locks.get(runId) ?? Promise.resolve()
    const next = previous.then(async () => {
      const run = await this.options.store.read(runId)
      if (!run) throw new Error(`No coding run ${runId}.`)
      const result = await fn(run)
      result.updatedAt = this.stamp()
      await this.options.store.save(result)
      return structuredClone(result)
    })
    this.locks.set(
      runId,
      next.catch(() => undefined)
    )
    return next
  }

  private stamp(): string {
    return this.now().toISOString()
  }
}

function newTurn(index: number, kind: CodingRunTurn['kind']): CodingRunTurn {
  return { index, kind, attempts: [], exportToken: randomBytes(16).toString('hex') }
}

const latest = (run: CodingRunView): CodingRunTurn => run.turns.at(-1)!
