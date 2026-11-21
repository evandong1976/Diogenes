/**
 * Shared workflow contract from approved graph intent to a locally verified candidate.
 *
 * Identities and how they correlate:
 * - `projectId` is the GitHub repository ID as a string.
 * - `threadId`, `draftId` and `proposalId` belong to the design thread and graph draft services.
 *   The workflow copies them into the frozen approval and never mints them.
 * - `approvalId` is the SHA-256 of the frozen approval packet bytes. The verifier reports it as
 *   `packetDigest`, so every verdict names the exact approval it checked.
 * - `handoffId` is one coding effort against one approval. Corrections stay in the same handoff.
 * - `runId` is the coding gateway's ID for one managed run. A handoff has one run per attempt.
 * - `candidateId` is the git commit SHA the workflow materialized from a run's output.
 */
import type { CatalogGraph, CatalogPatch, CatalogPatchResult } from './catalog'

export interface WorkflowCorrelation {
  projectId: string
  threadId: string
  draftId: string
  proposalId: string
}

// ---------------------------------------------------------------- frozen approval

export type ObligationId = 'native-typecheck' | 'graph-conformance' | 'bend-law'
export type Outcome = 'pass' | 'fail' | 'unknown'

/** A file at the approved base commit, frozen so the coding run and verifier see the same input. */
export interface SourceContext {
  path: string
  /** Git blob SHA at the base commit. */
  blob: string
  text: string
}

/**
 * The frozen approval packet. Everything here is covered by `approvalId`. It records the design
 * decisions (patch, required changes, preserved behavior, obligations) and names the choices left
 * to the implementation.
 */
export interface ApprovedChange {
  version: 1
  repository: { id: number; fullName: string }
  /** Full SHA of the baseline commit the patch was approved against. */
  baseCommit: string
  catalog: { schemaVersion: number; revision: number; bindingPath: string }
  targetComponentId: string
  beforeDigest: string
  patch: CatalogPatch
  afterDigest: string
  transitionIds: string[]
  bindings: {
    /** Candidate directory, relative to the repository root. */
    root: string
    reducer: { file: string; export: string }
    proof: { file: string }
    caller: { file: string; export: string }
  }
  obligations: { id: ObligationId; scope: string }[]
  requiredChanges: string[]
  preserved: string[]
  openChoices: string[]
  toolchain: { bendVersion: string; verifier: string; lawSourceDigest: string }
  /** Present on approvals frozen by the workflow. Hand-frozen fixture packets omit them. */
  correlation?: WorkflowCorrelation
  sourceContext?: SourceContext[]
}

export interface ApprovalRecord {
  approvalId: string
  correlation: WorkflowCorrelation
  approvedAt: string
  approvedBy: string
  packet: ApprovedChange
}

/** What the draft service hands over when the developer approves a previewed proposal. */
export interface ApprovalRequest {
  correlation: WorkflowCorrelation
  /** Observed catalog at the base commit. Its `commit.sha` is the frozen base. */
  baseline: CatalogGraph
  patch: CatalogPatch
  approvedBy: string
}

// ---------------------------------------------------------------- coding gateway (Session 3)

export interface CandidateFile {
  /** Repository-relative path. */
  path: string
  text: string
}

/** One managed coding run's input. `brief` is the Markdown the coding agent reads. */
export interface CodingHandoff {
  handoffId: string
  approvalId: string
  attempt: number
  correlation: WorkflowCorrelation
  repository: { id: number; fullName: string }
  baseCommit: string
  brief: string
  /** Files to seed the remote workspace with, at the base commit. */
  workspace: CandidateFile[]
  /** Paths the run may change. The workflow rejects candidates that touch anything else. */
  editableRoot: string
  correction?: CorrectionRequest
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface RunEvent {
  at: string
  kind: 'status' | 'message' | 'tool' | 'steer' | 'error'
  text: string
}

export interface CodingRunSnapshot {
  runId: string
  handoffId: string
  approvalId: string
  status: RunStatus
  /** Provider status verbatim, for example the Interactions API status. */
  remoteStatus?: string
  events: RunEvent[]
  error?: string
}

/** What a completed run produced. Completion only means a candidate is ready for review. */
export interface CandidateBundle {
  runId: string
  handoffId: string
  approvalId: string
  baseCommit: string
  /** Full contents of every changed or added file. */
  files: CandidateFile[]
  deleted: string[]
  /** What the run said about itself. Recorded, never used for acceptance. */
  remoteClaim?: string
}

/**
 * Managed coding boundary (Session 3). Notes from the Interactions API docs that shape it:
 * - `completed` only means the interaction finished. Map `incomplete` (budget hit) and
 *   `requires_continuation` by continuing inside the gateway, or report them as `failed`.
 * - A running interaction takes no new input. `steer` queues guidance that the gateway sends as a
 *   chained interaction (`previous_interaction_id` plus the same `environment`) once the current
 *   one stops, and records a `steer` event either way.
 * - Retrieve changed files from the environment files API rather than from model output.
 * - Interaction labels are lowercase and at most 63 characters, so tag runs with `handoffId` and
 *   `attempt`. The 64-hex `approvalId` does not fit; echo it from the handoff instead.
 */
export interface CodingGateway {
  submit(handoff: CodingHandoff): Promise<CodingRunSnapshot>
  get(runId: string): Promise<CodingRunSnapshot>
  steer(runId: string, message: string): Promise<CodingRunSnapshot>
  cancel(runId: string): Promise<CodingRunSnapshot>
  /** Rejects unless the run completed. */
  retrieveCandidate(runId: string): Promise<CandidateBundle>
}

// ---------------------------------------------------------------- verdicts

/** Why an obligation has no pass or fail. */
export type UnknownReason = 'unsupported' | 'unavailable' | 'inconclusive'

export interface ObligationVerdict {
  id: ObligationId
  outcome: Outcome
  unknownReason?: UnknownReason
  /** What the obligation promises, copied from the approval. */
  scope: string
  tool: string
  target: string
  evidence: Record<string, unknown>
  diagnostic?: string
}

export interface Verdict {
  approvalId: string
  candidateId: string
  handoffId: string
  runId: string
  verifier: string
  verifiedAt: string
  /** The run's own completion claim, kept beside the local result for explanation only. */
  remoteClaim: RunStatus
  overall: Outcome
  obligations: ObligationVerdict[]
  /** Set when the verifier refused to run, for example a digest or ancestry mismatch. */
  invalid?: string
}

export interface Mismatch {
  obligationId: ObligationId
  /** Approved transition IDs the diagnostic names. */
  transitionIds: string[]
  lines: string[]
}

/** Structured result the design thread receives. Enough to explain and to ask for a fix. */
export type ThreadMessage =
  | {
      kind: 'verdict'
      handoffId: string
      approvalId: string
      candidateId: string
      runId: string
      attempt: number
      verdict: Verdict
      mismatches: Mismatch[]
      /** Present when a bounded correction against the same approval is allowed. */
      correctable?: { obligationIds: ObligationId[]; attemptsLeft: number }
    }
  | {
      kind: 'decision'
      handoffId: string
      approvalId: string
      reason: DecisionReason
      detail: string
      options: DecisionOption[]
    }
  | { kind: 'run'; handoffId: string; runId: string; status: RunStatus; detail?: string }

export type DecisionReason =
  'missing-evidence' | 'attempts-exhausted' | 'run-failed' | 'candidate-rejected'
export type DecisionOption = 'reverify' | 'revise-design' | 'retry-run' | 'close'

/** Design thread service (Session 1). The workflow posts results here. */
export interface DesignThreadSink {
  /** `correlation` names the project the thread belongs to. */
  post(threadId: string, message: ThreadMessage, correlation: WorkflowCorrelation): Promise<void>
}

export interface CorrectionRequest {
  /** Must be failing obligations of the latest verdict. */
  obligationIds: ObligationId[]
  instructions: string
  previousCandidateId: string
  mismatches: Mismatch[]
}

// ---------------------------------------------------------------- workflow state

export type HandoffStage =
  'coding' | 'verifying' | 'accepted' | 'correctable' | 'needs-decision' | 'closed'

export interface CandidateRecord {
  candidateId: string
  runId: string
  attempt: number
  files: string[]
  deleted: string[]
  remoteClaim?: string
}

export interface RunRecord {
  attempt: number
  run: CodingRunSnapshot
  correction?: CorrectionRequest
  candidate?: CandidateRecord
  /** Why the candidate was not materialized. */
  candidateRejected?: string
  verdict?: Verdict
}

export interface HandoffRecord {
  handoffId: string
  approvalId: string
  correlation: WorkflowCorrelation
  stage: HandoffStage
  maxAttempts: number
  runs: RunRecord[]
  decision?: Extract<ThreadMessage, { kind: 'decision' }>
  /** Thread posts that failed. The state stays queryable; delivery can be retried. */
  undelivered: ThreadMessage[]
  createdAt: string
  updatedAt: string
}

export interface ProjectWorkflowState {
  projectId: string
  approvals: ApprovalRecord[]
  handoffs: HandoffRecord[]
}

/** Optional presentation context a UI can pass through without the workflow interpreting it. */
export interface PresentationContext {
  selectedComponentId?: string
}

/**
 * Headless command and query surface of `WorkflowService`. The IPC bridge exposes it project-scoped
 * through `BackendApi.workflow` (src/shared/backend.ts).
 */
export interface WorkflowApi {
  preview(request: Pick<ApprovalRequest, 'baseline' | 'patch'>): Promise<CatalogPatchResult>
  approve(request: ApprovalRequest): Promise<ApprovalRecord>
  startHandoff(approvalId: string, context?: PresentationContext): Promise<HandoffRecord>
  refresh(handoffId: string): Promise<HandoffRecord>
  steer(handoffId: string, message: string): Promise<HandoffRecord>
  cancel(handoffId: string): Promise<HandoffRecord>
  requestCorrection(
    handoffId: string,
    request: Pick<CorrectionRequest, 'obligationIds' | 'instructions'>
  ): Promise<HandoffRecord>
  resolveDecision(handoffId: string, option: DecisionOption): Promise<HandoffRecord>
  getHandoff(handoffId: string): Promise<HandoffRecord | null>
  getProject(projectId: string): Promise<ProjectWorkflowState>
}
