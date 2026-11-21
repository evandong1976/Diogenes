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
import type { CodingRunRepository } from './store'

const activityLimit = 200
const textLimit = 4_000

export interface GatewayOptions {
  store: CodingRunRepository
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
      else if (run.phase === 'starting' && !this.inflight.has(runId)) this.orphaned(run)
      else if (run.phase === 'cancelled' && run.cancellation?.outcome === 'requested')
        await this.confirmCancel(run)
      return run
    })
  }

  /**
   * Asks the provider to stop the latest turn, then reads it back so the recorded outcome is what
   * the provider confirmed. A create still in flight is awaited first, so its interaction ID is
   * known. The run takes no further turns afterwards.
   */
  async cancel(runId: string): Promise<CodingRunView> {
    await this.settle(runId)
    return this.withRun(runId, async (run) => {
      if (run.phase === 'cancelled') return run
      const turn = latest(run)
      const requestedAt = this.stamp()
      const id = turn.interactionId
      if (run.phase === 'starting' && !this.inflight.has(runId)) this.orphaned(run)
      if (run.phase !== 'running' && run.phase !== 'uncertain') {
        run.cancellation = {
          outcome: 'not-running',
          requestedAt,
          ...(id && { interactionId: id }),
          detail: `No turn was running (the run was ${run.phase}).`
        }
      } else if (!id) {
        run.cancellation = {
          outcome: 'unconfirmed',
          requestedAt,
          detail:
            'The provider never returned an interaction ID for this turn, so it cannot be cancelled. Remote work may exist.'
        }
      } else {
        run.cancellation = { outcome: 'requested', requestedAt, interactionId: id, detail: '' }
        let failure: string | undefined
        try {
          await this.options.provider.cancel(id)
        } catch (error) {
          if (!(error instanceof ProviderError && error.kind === 'gone'))
            failure = (error as Error).message
        }
        // Read the turn back either way: a rejected cancel may mean it had already finished.
        await this.confirmCancel(run)
        if (failure && run.cancellation.outcome === 'requested') {
          run.cancellation.outcome = 'unconfirmed'
          run.cancellation.detail = `The cancel request failed (${failure}); remote work may still be running.`
        }
      }
      run.phase = 'cancelled'
      return run
    })
  }

  async reopen(runId: string): Promise<CodingRunView> {
    return this.withRun(runId, async (run) => {
      if (run.phase === 'starting' && !this.inflight.has(runId)) {
        this.orphaned(run)
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
      if (!run.environmentId) throw new Error('The run has no workspace to continue.')
      // An expired workspace cannot be continued; say so now instead of failing the send.
      const env = await this.options.provider
        .environmentStatus(run.environmentId)
        .catch(() => 'active' as const)
      if (env !== 'active') {
        run.phase = 'expired'
        return run
      }
      const turn = newTurn(run.turns.length, 'follow_up')
      turn.message = message.trim()
      run.turns.push(turn)
      run.candidate = { status: 'none' }
      run.phase = 'starting'
      return run
    })
    if (view.phase === 'expired') throw new Error('The managed workspace has expired.')
    this.dispatch(runId)
    return view
  }

  async retry(runId: string): Promise<CodingRunView> {
    const view = await this.withRun(runId, async (run) => {
      if (run.phase === 'starting' && !this.inflight.has(runId)) this.orphaned(run)
      if (run.phase !== 'uncertain') throw new Error(`Only an uncertain run can be retried.`)
      // The provider has no idempotency key; the resend is marked as a possible duplicate.
      if (latest(run).interactionId)
        throw new Error('This turn already reached the provider; refresh it instead.')
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
      request = this.request(run, input, turn)
      turn.attempts.push({
        requestedAt: this.stamp(),
        submittedInput: request.input,
        ...(turn.attempts.length > 0 && { mayDuplicate: true })
      })
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
    if (turn.kind === 'start')
      return {
        sources: stagedSources(input.files, this.options.exportScript),
        input: turnPrompt(input, turn)
      }
    const previous = run.turns
      .slice(0, turn.index)
      .reverse()
      .find((t) => t.interactionId)?.interactionId
    return {
      previousInteractionId: previous,
      environmentId: run.environmentId,
      input: turnPrompt(input, turn)
    }
  }

  /** The app stopped between saving a turn and hearing back from the provider. */
  private orphaned(run: CodingRunView): void {
    const attempt = latest(run).attempts.at(-1)
    if (attempt && !attempt.interactionId && !attempt.error)
      attempt.error = 'Diogenes stopped before the provider replied.'
    run.phase = 'uncertain'
  }

  /** Reads the cancelled turn back and records what the provider reports. */
  private async confirmCancel(run: CodingRunView): Promise<void> {
    const c = run.cancellation!
    let interaction: ProviderInteraction
    try {
      interaction = await this.options.provider.get(c.interactionId!)
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'gone') {
        c.outcome = 'confirmed'
        c.detail = 'The provider no longer has the interaction.'
      } else c.detail = 'Cancel sent; the provider has not confirmed it yet.'
      return
    }
    latest(run).providerStatus = interaction.status
    if (interaction.status === 'cancelled') {
      c.outcome = 'confirmed'
      c.detail = 'The provider reports the turn cancelled.'
    } else if (isActive(interaction.status)) {
      c.outcome = 'requested'
      c.detail = `Cancel sent; the provider still reports ${interaction.status}.`
    } else {
      c.outcome = 'finished'
      c.detail = `The turn had already ended (${interaction.status}) before the cancel took effect.`
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
    const previousSteps = run.activity.filter((a) => a.turn === turn.index)
    if (!isActive(interaction.status) || interaction.steps.length >= previousSteps.length) {
      run.activity = [
        ...run.activity.filter((a) => a.turn !== turn.index),
        ...interaction.steps.map((s): CodingActivity => ({
          turn: turn.index,
          kind: s.type,
          text: s.text.slice(0, textLimit)
        }))
      ].slice(-activityLimit)
    }

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
      run.candidate = {
        status: 'missing',
        reason:
          interaction.status === 'incomplete'
            ? 'The coding agent reached its token budget before exporting changes. Send a follow-up to continue in the same workspace.'
            : 'The agent did not export a candidate.'
      }
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

/**
 * The exact text a turn sends to the managed agent. Pure over the persisted run input and turn
 * (including its stored export token), so the submitted bytes can be shown again after a restart.
 */
/** Plain shell in the managed workspace, one command at a time, so the trace stays readable. */
const SUMMARY_NOTE =
  'When you finish, reply with two or three plain sentences for the developer: what you changed in their code, in which files, and anything they should know.'

const SHELL_NOTE = `Work in ${workspaceRoot}. It contains only the approved source files and has no Git metadata. Use simple shell commands such as ls, cat, grep and sed to inspect and edit those files. Run a focused check where possible. The export command builds the patch against the pinned source copies.`

export function turnPrompt(input: StartCodingRun, turn: CodingRunTurn): string {
  const finish = `When you are done, run exactly this command and confirm it printed DIOGENES_CANDIDATE_WRITTEN:\n${exportCommand(turn.exportToken)}`
  if (turn.kind === 'start') {
    const { handoff } = input
    const list = (items: string[]): string => items.map((i) => `- ${i}`).join('\n')
    return [
      handoff.intent,
      '',
      '## Coding workspace',
      `Implement this plan in ${workspaceRoot}. It holds the in-scope files of ${handoff.repository.fullName} at commit ${handoff.baseCommit}.`,
      ...(handoff.guarantees.length
        ? ['', 'Guarantees that must hold:', list(handoff.guarantees)]
        : []),
      ...(handoff.latitude.length
        ? ['', 'Decisions you may make yourself:', list(handoff.latitude)]
        : []),
      '',
      'Change only these paths:',
      list(handoff.scope),
      ...(handoff.acceptance
        ? ['', `Check your work by running, from ${workspaceRoot}:`, handoff.acceptance.command]
        : []),
      '',
      SHELL_NOTE,
      SUMMARY_NOTE,
      'Do not modify /workspace/.diogenes.',
      finish
    ].join('\n')
  }
  return [
    'A follow-up about the same code change:',
    turn.message ?? '',
    '',
    'Keep the guarantees and path limits from the original task.',
    SHELL_NOTE,
    SUMMARY_NOTE,
    finish
  ].join('\n')
}

const latest = (run: CodingRunView): CodingRunTurn => run.turns.at(-1)!
