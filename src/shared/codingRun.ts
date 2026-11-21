/**
 * Managed coding runs: a frozen design handoff sent to a Gemini Managed Agents (Antigravity)
 * session that can be steered and returns a patch candidate for local verification.
 *
 * These types are shared by main, preload and any headless client. Provider credentials and
 * provider-specific payloads never appear here.
 */

/** The approved, frozen intent handed to the coding agent. Produced by the approval step. */
export interface CodingHandoff {
  /** Stable ID of the approved handoff. */
  handoffId: string
  /** sha256 hex of the frozen handoff as approved. The candidate is tied to this value. */
  digest: string
  repository: { id: number; fullName: string }
  /** Full 40-character commit SHA the change was approved against. */
  baseCommit: string
  /** The requested behavior, in plain language. */
  intent: string
  /** Guarantees the implementation must keep. */
  guarantees: string[]
  /** Implementation decisions the coding agent may make on its own. */
  latitude: string[]
  /** Repo-relative paths the agent may change. Every supplied source file must be in scope. */
  scope: string[]
  /** Optional check the agent can run in its sandbox. Local verification stays authoritative. */
  acceptance?: { command: string; description?: string }
  /** Presentation context from a client, such as the selected component. Not sent to the agent. */
  context?: { componentId?: string; threadId?: string }
}

/** Source text at `baseCommit`, staged into the remote workspace. */
export interface SourceFile {
  path: string
  content: string
}

export interface StartCodingRun {
  handoff: CodingHandoff
  files: SourceFile[]
}

/**
 * Lifecycle of a run.
 * - `starting`: persisted locally; the provider create call has not returned yet.
 * - `uncertain`: the latest turn's create call failed after it may have reached the provider, or
 *   the app stopped mid-call. Work may exist remotely. Nothing is resent until a client calls
 *   `retry`, and every resend is recorded in the turn's `attempts`.
 * - `running`: the latest turn is queued or in progress at the provider.
 * - `idle`: the latest turn finished. The run can take a follow-up; see `candidate`.
 * - `failed`: the start was rejected or its turn failed. A failed follow-up returns to `idle`.
 * - `expired`: the provider no longer has the interaction or environment. The workspace is gone.
 */
export type CodingRunPhase = 'starting' | 'uncertain' | 'running' | 'idle' | 'failed' | 'expired'

export interface CodingRunTurn {
  /** 0 is the start; each follow-up adds one. */
  index: number
  kind: 'start' | 'follow_up'
  /** The developer's direction for a follow-up. The start turn carries the handoff instead. */
  message?: string
  /** Each provider create request for this turn. More than one means it was retried on request. */
  attempts: { requestedAt: string; interactionId?: string; error?: string }[]
  interactionId?: string
  providerStatus?: string
  /** Passed to the export script so a candidate from an earlier turn is not mistaken for this one. */
  exportToken: string
  completedAt?: string
  error?: string
}

export interface CodingActivity {
  turn: number
  kind: 'text' | 'command' | 'command_output' | 'other'
  text: string
}

/**
 * A candidate implementation. `patch` is a `git diff --binary` against `baseCommit` that
 * `git apply --index` accepts on a clean checkout of that commit.
 */
export interface CodingCandidate {
  runId: string
  handoffId: string
  handoffDigest: string
  baseCommit: string
  patch: string
  /** sha256 hex of `patch`, as computed in the sandbox and checked again here. */
  patchSha256: string
  /** Paths the patch touches. All are inside the handoff scope. */
  files: string[]
  provenance: {
    provider: 'antigravity'
    agent: string
    /** The turn and interaction that produced this candidate. */
    turn: number
    interactionId: string
    environmentId?: string
    /** sha256 of the staged sources, so the base the agent saw can be checked. */
    sourceDigest: string
    retrievedAt: string
  }
  /** Agent-reported acceptance output. Informational only; not evidence of correctness. */
  agentReport?: string
}

export type CandidateState =
  | { status: 'none' }
  | { status: 'ready'; candidate: CodingCandidate }
  /** The turn finished but no valid candidate could be read from it. */
  | { status: 'missing'; reason: string }

export interface CodingRunView {
  runId: string
  handoffId: string
  handoffDigest: string
  baseCommit: string
  phase: CodingRunPhase
  createdAt: string
  updatedAt: string
  environmentId?: string
  turns: CodingRunTurn[]
  activity: CodingActivity[]
  candidate: CandidateState
  context?: CodingHandoff['context']
}

export type CodingRunSummary = Pick<
  CodingRunView,
  'runId' | 'handoffId' | 'phase' | 'updatedAt' | 'baseCommit'
> & { candidate: CandidateState['status'] }

export interface CodingRunApi {
  /** Validates and persists the run, then sends it. Returns as soon as a run ID exists. */
  start(input: StartCodingRun): Promise<CodingRunView>
  /** Current state, refreshed from the provider when a turn is in flight. */
  status(runId: string): Promise<CodingRunView>
  /** Loads a persisted run after a restart and reconciles it with the provider. */
  reopen(runId: string): Promise<CodingRunView>
  /** Directs the same managed workspace. Only allowed when the run is `idle`. */
  followUp(runId: string, message: string): Promise<CodingRunView>
  /** Resends the latest turn of an `uncertain` run. Never called automatically. */
  retry(runId: string): Promise<CodingRunView>
  list(): Promise<CodingRunSummary[]>
}

export const codingRunChannels = {
  start: 'coding-run:start',
  status: 'coding-run:status',
  reopen: 'coding-run:reopen',
  followUp: 'coding-run:follow-up',
  retry: 'coding-run:retry',
  list: 'coding-run:list'
} as const
