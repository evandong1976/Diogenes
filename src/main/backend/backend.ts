/**
 * The integrated agent backend: persistent threads, design turns and the graph draft, frozen
 * approvals, managed coding runs, candidates and local verdicts. Electron-free, so the same
 * object serves IPC handlers, scripts and tests.
 *
 * Storage: Postgres whenever DIOGENES_DATABASE_URL is set, with no fallback if it is unreachable
 * or unmigrated. Without it, the services' file stores under `dataDir` (local development).
 *
 * Authorization: every call starts with `authorize(projectId)`, and every ID the caller supplies
 * is looked up inside that project. A thread, turn, proposal, approval, handoff or run that
 * belongs to another project is reported as not found.
 */
import { join } from 'node:path'
import { CodingRunGateway, turnPrompt } from '../coding/gateway'
import { sha256 } from '../coding/candidate'
import { CodingRunStore, type CodingRunRepository } from '../coding/store'
import type { ManagedAgentProvider } from '../coding/provider'
import { DesignService } from '../design/harness'
import type { ModelClient } from '../design/model'
import { DesignStore, type DesignStateStore } from '../design/store'
import type { SourceReader, VerificationSource } from '../design/tools'
import { ThreadStore, type ThreadRepository } from '../threads/store'
import { WorkflowService } from '../workflow/service'
import { WorkflowStore, type WorkflowRepository } from '../workflow/store'
import type { LocalVerifier } from '../workflow/verifiers'
import { databaseConfigured, openDatabase, type Database } from '../persistence/db'
import { PgCodingRunStore } from '../persistence/coding'
import { PgDesignStore } from '../persistence/design'
import { assertMigrated, migrate, SCHEMA_VERSION } from '../persistence/migrations'
import { PgThreadStore } from '../persistence/threads'
import { PgWorkflowStore, verdictId } from '../persistence/workflow'
import { ManagedCodingAdapter } from './coding'
import type { RepoSource } from './repos'
import { StoredThreadHistory, StoredWorkflowSink } from './threads'
import type { CatalogGraph } from '../../shared/catalog'
import type { CodingRunSummary, CodingRunView } from '../../shared/codingRun'
import type {
  BackendApi,
  BackendStatus,
  DesignApproval,
  DesignTurnResult,
  RecordedVerdict
} from '../../shared/backend'
import type { DesignTurnInput, ProjectState, VerificationReport } from '../../shared/design'
import type {
  ApprovalRecord,
  CandidatePublisher,
  CorrectionRequest,
  DecisionOption,
  HandoffRecord,
  ObligationId,
  SubmittedBrief,
  Verdict
} from '../../shared/workflow'

/** The verified caller of one project. */
export interface ProjectAccess {
  projectId: string
  repository: { id: number; fullName: string }
  /** Verified account name, recorded as the approver. Never taken from the renderer. */
  account: string
}

export interface ProjectAuthorizer {
  /** Resolves when the signed-in account may use this project; rejects otherwise. */
  authorize(projectId: string): Promise<ProjectAccess>
}

export class NotFoundError extends Error {}

export interface BackendOptions {
  env?: NodeJS.ProcessEnv
  /** Local working data: candidate repositories, packet cache, and file stores without a database. */
  dataDir: string
  authorizer: ProjectAuthorizer
  model: ModelClient
  models: readonly string[]
  observedCatalog(repositoryId: number): Promise<CatalogGraph | null>
  readSource: SourceReader
  /** Built lazily on the first coding call, so a missing provider key only fails coding. */
  codingProvider: () => ManagedAgentProvider
  exportScript: string
  /**
   * Local git copies of the authorized repositories. The base commit of every approval is fetched
   * into it on demand, so no local clone has to be configured.
   */
  repos: RepoSource
  verifiers: LocalVerifier[]
  /** Pushes verified candidates to review branches. Absent in fixtures unless a test supplies one. */
  publisher?: CandidatePublisher
  /** Apply pending migrations on open instead of requiring `pnpm db:migrate` first. */
  migrate?: boolean
  maxAttempts?: number
}

interface Stores {
  db: Database | null
  threads: ThreadRepository
  design: DesignStateStore
  workflow: WorkflowRepository
  coding: CodingRunRepository
}

const PROJECT = /^[0-9]{1,20}$/

export async function createBackend(options: BackendOptions): Promise<AgentBackend> {
  const env = options.env ?? process.env
  let stores: Stores
  if (databaseConfigured(env)) {
    const db = openDatabase(env)
    try {
      if (options.migrate) await migrate(db)
      await assertMigrated(db)
    } catch (error) {
      await db.close()
      throw error
    }
    stores = {
      db,
      threads: new PgThreadStore(db),
      design: new PgDesignStore(db),
      workflow: new PgWorkflowStore(db, join(options.dataDir, 'workflow')),
      coding: new PgCodingRunStore(db)
    }
  } else {
    stores = {
      db: null,
      threads: new ThreadStore(join(options.dataDir, 'threads')),
      design: new DesignStore(join(options.dataDir, 'design')),
      workflow: new WorkflowStore(join(options.dataDir, 'workflow')),
      coding: new CodingRunStore(join(options.dataDir, 'coding-runs'))
    }
  }
  return new AgentBackend(options, stores)
}

export class AgentBackend implements BackendApi {
  readonly design: BackendApi['design']
  readonly threads: BackendApi['threads']
  readonly workflow: BackendApi['workflow']
  readonly coding: BackendApi['coding']
  private readonly designService: DesignService
  private readonly workflowService: WorkflowService
  private codingGateway: CodingRunGateway | null = null

  constructor(
    private readonly options: BackendOptions,
    private readonly stores: Stores
  ) {
    const verification: VerificationSource = {
      latest: (intentId, projectId) => this.latestReport(projectId, intentId)
    }
    this.designService = new DesignService({
      store: stores.design,
      observedCatalog: options.observedCatalog,
      readSource: options.readSource,
      verification,
      history: new StoredThreadHistory(stores.threads),
      model: options.model,
      models: options.models
    })
    this.workflowService = new WorkflowService({
      storeDir: join(options.dataDir, 'workflow'),
      store: stores.workflow,
      repoFor: (projectId) => options.repos.dir(projectId),
      gateway: new ManagedCodingAdapter({
        gateway: lazyGateway(() => this.gateway()),
        store: stores.coding,
        repoFor: (projectId) => options.repos.dir(projectId)
      }),
      threads: new StoredWorkflowSink(stores.threads),
      verifiers: options.verifiers,
      ...(options.publisher && { publisher: options.publisher }),
      ...(options.maxAttempts && { maxAttempts: options.maxAttempts })
    })

    const t = stores.threads
    this.threads = {
      create: async (projectId, input) =>
        t.create((await this.authorize(projectId)).projectId, input),
      list: async (projectId, filter) =>
        t.list((await this.authorize(projectId)).projectId, filter),
      open: async (projectId, threadId) =>
        t.open((await this.authorize(projectId)).projectId, threadId),
      eventsSince: async (projectId, threadId, afterSeq) =>
        t.eventsSince((await this.authorize(projectId)).projectId, threadId, afterSeq)
    }

    const d = this.designService
    this.design = {
      openProject: async (projectId) => {
        const access = await this.authorize(projectId)
        return d.openProject(projectId, access.repository.id)
      },
      getProject: async (projectId) => d.getProject((await this.authorize(projectId)).projectId),
      startTurn: (input) => this.startTurn(input),
      cancelTurn: async (projectId, turnId) => {
        const state = await d.getProject((await this.authorize(projectId)).projectId)
        if (!state.turns.some((turn) => turn.id === turnId))
          throw new NotFoundError(`No turn ${turnId}.`)
        return d.cancelTurn(turnId)
      },
      reject: async (projectId, proposalId, reason) =>
        d.reject((await this.authorize(projectId)).projectId, proposalId, reason),
      approve: (projectId, proposalId, expectedRevision) =>
        this.approve(projectId, proposalId, expectedRevision)
    }

    const w = this.workflowService
    this.workflow = {
      preview: (request) => w.preview(request),
      getProject: async (projectId) => w.getProject((await this.authorize(projectId)).projectId),
      startHandoff: async (projectId, approvalId) => {
        await this.approvalIn(projectId, approvalId)
        return w.startHandoff(approvalId)
      },
      getHandoff: async (projectId, handoffId) => {
        await this.authorize(projectId)
        const h = await stores.workflow.handoff(handoffId)
        return h && h.correlation.projectId === projectId ? h : null
      },
      refresh: async (projectId, handoffId) =>
        w.refresh(await this.handoffIn(projectId, handoffId)),
      steer: async (projectId, handoffId, message) =>
        w.steer(await this.handoffIn(projectId, handoffId), text(message)),
      cancel: async (projectId, handoffId) => w.cancel(await this.handoffIn(projectId, handoffId)),
      requestCorrection: async (projectId, handoffId, request) =>
        w.requestCorrection(await this.handoffIn(projectId, handoffId), request),
      resolveDecision: async (projectId, handoffId, option: DecisionOption) =>
        w.resolveDecision(await this.handoffIn(projectId, handoffId), option),
      verdicts: (projectId, handoffId) => this.verdicts(projectId, handoffId),
      verifiedPatch: async (projectId, handoffId) =>
        w.verifiedPatch(await this.handoffIn(projectId, handoffId)),
      briefPreview: async (projectId, approvalId) => {
        await this.approvalIn(projectId, approvalId)
        return w.briefPreview(approvalId)
      },
      briefs: async (projectId, handoffId) =>
        this.submittedBriefs(await this.handoffIn(projectId, handoffId)),
      candidateDiff: async (projectId, handoffId, attempt) =>
        w.candidateDiff(await this.handoffIn(projectId, handoffId), Number(attempt)),
      publishVerified: async (projectId, handoffId) =>
        w.publishVerified(await this.handoffIn(projectId, handoffId))
    }

    this.coding = {
      list: async (projectId) => {
        await this.authorize(projectId)
        const runs =
          stores.coding instanceof PgCodingRunStore
            ? await stores.coding.forProject(projectId).list()
            : await this.fileRunsIn(projectId)
        return runs.map(summarize)
      },
      status: async (projectId, runId) => this.gateway().status(await this.runIn(projectId, runId)),
      retry: async (projectId, runId) => this.gateway().retry(await this.runIn(projectId, runId)),
      cancel: async (projectId, runId) => this.gateway().cancel(await this.runIn(projectId, runId))
    }
  }

  /**
   * Each attempt's approved brief and recorded provider input. Older runs retain enough
   * information to reconstruct the input for inspection.
   */
  private async submittedBriefs(handoffId: string): Promise<SubmittedBrief[]> {
    const h = (await this.stores.workflow.handoff(handoffId))!
    const briefs: SubmittedBrief[] = []
    for (const r of h.runs) {
      const [run, input] = await Promise.all([
        this.stores.coding.read(r.run.runId),
        this.stores.coding.input(r.run.runId)
      ])
      const turn = run?.turns[r.run.turn ?? 0]
      if (!run || !input || !turn) continue
      const recorded = turn.attempts.at(-1)?.submittedInput
      const submitted = recorded ?? turnPrompt(input, turn)
      briefs.push({
        attempt: r.attempt,
        origin: r.origin ?? 'start',
        runId: r.run.runId,
        turn: turn.index,
        markdown: turn.kind === 'start' ? input.handoff.intent : (turn.message ?? ''),
        submitted,
        exact: recorded !== undefined,
        sha256: sha256(submitted),
        scope: input.handoff.scope,
        sources: turn.kind === 'start' ? input.files.map((f) => f.path) : []
      })
    }
    return briefs
  }

  async status(): Promise<BackendStatus> {
    return {
      storage: this.stores.db ? 'postgres' : 'files',
      schemaVersion: this.stores.db ? SCHEMA_VERSION : null
    }
  }

  /** Waits for background provider work on a run (used by headless callers and tests). */
  async settleRun(runId: string): Promise<void> {
    await this.gateway().settle(runId)
  }

  async close(): Promise<void> {
    await this.stores.db?.close()
  }

  // ------------------------------------------------------------------ design

  private async startTurn(input: DesignTurnInput): Promise<DesignTurnResult> {
    const { projectId } = await this.authorize(input?.projectId)
    const thread = await this.stores.threads.open(projectId, input.threadId)
    if (thread.kind !== 'design') throw new Error(`Thread ${thread.id} is not a design thread.`)
    const turn = await this.designService.startTurn({ ...input, projectId })
    if (!turn.correctionId) return { turn }
    const state = await this.designService.getProject(projectId)
    const correction = state.corrections.find((c) => c.id === turn.correctionId)!
    try {
      const handoff = await this.forwardCorrection(state, correction)
      return { turn, handoff }
    } catch (error) {
      return { turn, correctionError: (error as Error).message }
    }
  }

  /**
   * Approves the proposal on the draft (only if the draft and the client are both at
   * `expectedRevision`), then freezes the approval the coding handoff will use. Both steps are
   * idempotent, so a retry after a crash between them completes the second one.
   */
  private async approve(
    projectId: string,
    proposalId: string,
    expectedRevision: number
  ): Promise<DesignApproval> {
    const access = await this.authorize(projectId)
    if (!Number.isSafeInteger(expectedRevision)) throw new Error('Expected a draft revision.')
    const design = await this.designService.approve(projectId, proposalId, expectedRevision)
    if (!design.ok) return { design, approval: null }
    const { intent } = design
    const proposal = (await this.designService.getProject(projectId)).proposals.find(
      (p) => p.id === proposalId
    )!
    if (!intent.baseGraph)
      return { design, approval: null, approvalError: 'The intent predates frozen baselines.' }
    try {
      // The exact indexed commit of the authorized repository, fetched by SHA if not yet local.
      await this.options.repos.ensure(
        projectId,
        access.repository.fullName,
        intent.baseGraph.commit.sha
      )
      const approval = await this.workflowService.approve({
        correlation: {
          projectId,
          threadId: intent.threadId,
          draftId: `draft:${intent.repository.id}@${intent.commitSha}`,
          proposalId
        },
        baseline: intent.baseGraph,
        patch: proposal.patch,
        approvedBy: access.account
      })
      return { design, approval }
    } catch (error) {
      return { design, approval: null, approvalError: (error as Error).message }
    }
  }

  /** The design agent's correction, forwarded to the handoff of the same approved proposal. */
  private async forwardCorrection(
    state: ProjectState,
    correction: ProjectState['corrections'][number]
  ): Promise<HandoffRecord> {
    const handoff = (await this.handoffsFor(state, correction.intentId)).at(-1)
    if (!handoff) throw new Error(`No coding handoff for intent ${correction.intentId}.`)
    const request: Pick<CorrectionRequest, 'obligationIds' | 'instructions'> = {
      obligationIds: correction.failedChecks as ObligationId[],
      instructions: correction.instructions
    }
    return this.workflowService.requestCorrection(handoff.handoffId, request)
  }

  // ------------------------------------------------------------------ verification bridge

  private async handoffsFor(state: ProjectState, intentId: string): Promise<HandoffRecord[]> {
    const intent = state.intents.find((i) => i.id === intentId)
    if (!intent) return []
    const approvals = new Set(
      (await this.stores.workflow.projectApprovals(state.projectId))
        .filter((a) => a.correlation.proposalId === intent.proposalId)
        .map((a) => a.approvalId)
    )
    return (await this.stores.workflow.projectHandoffs(state.projectId)).filter((h) =>
      approvals.has(h.approvalId)
    )
  }

  private async latestReport(
    projectId: string,
    intentId: string
  ): Promise<VerificationReport | null> {
    const state = await this.stores.design.read(projectId)
    const run = (await this.handoffsFor(state, intentId))
      .flatMap((h) => h.runs)
      .filter((r) => r.verdict)
      .at(-1)
    return run?.verdict ? toReport(intentId, run.verdict) : null
  }

  private async verdicts(projectId: string, handoffId: string): Promise<RecordedVerdict[]> {
    const handoff = await this.handoffIn(projectId, handoffId)
    if (this.stores.workflow instanceof PgWorkflowStore)
      return this.stores.workflow.verdicts(projectId, handoff)
    const h = (await this.stores.workflow.handoff(handoff))!
    return h.runs.flatMap((r) =>
      r.verdict ? [{ ...r.verdict, verdictId: verdictId(r.verdict) }] : []
    )
  }

  // ------------------------------------------------------------------ scoping

  private async authorize(projectId: unknown): Promise<ProjectAccess> {
    if (typeof projectId !== 'string' || !PROJECT.test(projectId))
      throw new Error('Expected a project ID (a GitHub repository ID).')
    const access = await this.options.authorizer.authorize(projectId)
    if (access.projectId !== projectId || String(access.repository.id) !== projectId)
      throw new Error(`Not authorized for project ${projectId}.`)
    return access
  }

  private async approvalIn(projectId: string, approvalId: unknown): Promise<ApprovalRecord> {
    const access = await this.authorize(projectId)
    const approval = await this.stores.workflow.approval(text(approvalId))
    if (!approval || approval.correlation.projectId !== projectId)
      throw new NotFoundError(`No approval ${String(approvalId)} in project ${projectId}.`)
    await this.options.repos.ensure(
      projectId,
      access.repository.fullName,
      approval.packet.baseCommit
    )
    return approval
  }

  /** Resolves a handoff inside the project and makes sure its base commit is local again. */
  private async handoffIn(projectId: string, handoffId: unknown): Promise<string> {
    await this.authorize(projectId)
    const h = await this.stores.workflow.handoff(text(handoffId))
    if (!h || h.correlation.projectId !== projectId)
      throw new NotFoundError(`No handoff ${String(handoffId)} in project ${projectId}.`)
    await this.approvalIn(projectId, h.approvalId)
    return h.handoffId
  }

  private async runIn(projectId: string, runId: unknown): Promise<string> {
    await this.authorize(projectId)
    const input = await this.stores.coding.input(text(runId)).catch(() => null)
    if (!input || String(input.handoff.repository.id) !== projectId)
      throw new NotFoundError(`No coding run ${String(runId)} in project ${projectId}.`)
    return text(runId)
  }

  private async fileRunsIn(projectId: string): Promise<CodingRunView[]> {
    const runs = await this.stores.coding.list()
    const mine = await Promise.all(
      runs.map(
        async (r) =>
          String((await this.stores.coding.input(r.runId))?.handoff.repository.id) === projectId
      )
    )
    return runs.filter((_, i) => mine[i])
  }

  private gateway(): CodingRunGateway {
    this.codingGateway ??= new CodingRunGateway({
      store: this.stores.coding,
      provider: this.options.codingProvider(),
      exportScript: this.options.exportScript
    })
    return this.codingGateway
  }
}

/** Defers building the provider (and reading its key) until a coding call needs it. */
function lazyGateway(get: () => CodingRunGateway): CodingRunGateway {
  return new Proxy({} as CodingRunGateway, {
    get: (_target, key) => {
      const gateway = get()
      const value = Reflect.get(gateway, key)
      return typeof value === 'function' ? value.bind(gateway) : value
    }
  })
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Expected a non-empty string.')
  return value
}

function summarize(run: CodingRunView): CodingRunSummary {
  return {
    runId: run.runId,
    handoffId: run.handoffId,
    phase: run.phase,
    updatedAt: run.updatedAt,
    baseCommit: run.baseCommit,
    candidate: run.candidate.status
  }
}

/** A local verdict in the design agent's terms. `unknown` stays unknown; it is never a pass. */
function toReport(intentId: string, verdict: Verdict): VerificationReport {
  return {
    intentId,
    runId: verdict.runId,
    status: verdict.invalid
      ? 'error'
      : verdict.overall === 'pass'
        ? 'passed'
        : verdict.overall === 'fail'
          ? 'failed'
          : 'unknown',
    checks: verdict.obligations.map((o) => ({
      name: o.id,
      passed: o.outcome === 'pass',
      outcome: o.outcome,
      ...((o.diagnostic || o.unknownReason) && {
        detail: [o.unknownReason, o.diagnostic].filter(Boolean).join(': ')
      })
    })),
    at: verdict.verifiedAt
  }
}
