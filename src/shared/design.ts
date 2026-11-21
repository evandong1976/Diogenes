import type {
  CatalogEdge,
  CatalogGraph,
  CatalogIssueCode,
  CatalogNode,
  CatalogOperation,
  CatalogPatch,
  CatalogSource
} from './catalog'

// Backend state for design turns: the working catalog draft, pending proposals, approved intents
// handed to coding, and the turn records a client needs to reopen a project and see where work is.
// Everything here is plain JSON so a headless client and a future IPC bridge see the same shapes.

/** The exact graph a client was looking at when it started a turn. */
export interface GraphRef {
  repositoryId: number
  commitSha: string
  /** Working draft revision. 0 is the observed catalog. */
  revision: number
}

export interface DesignTurnInput {
  projectId: string
  threadId: string
  /** A Gemini model ID from `DesignService.models`. Each turn may use a different one. */
  model: string
  graph: GraphRef
  message: string
  /** Presentation context, e.g. the canvas node the developer has selected. Catalog node ID. */
  selectedComponentId?: string
}

export type SelectionResolution =
  | { status: 'none' }
  | { status: 'resolved'; componentId: string; name: string; kind: CatalogNode['kind'] }
  /** The ID is not in the draft at the supplied revision. `removedAtRevision` when a draft edit deleted it. */
  | { status: 'missing'; componentId: string; removedAtRevision?: number; message: string }

export type TurnStatus =
  | 'running'
  /** The turn produced a proposal and stopped. Approve or reject it to continue. */
  | 'awaiting-approval'
  | 'completed'
  | 'cancelled'
  | 'failed'
  /** The process stopped while the turn was running. The draft was not changed by it. */
  | 'interrupted'
  /** The supplied graph reference is not the current draft. Nothing ran. */
  | 'stale-graph'

export interface ToolCallRecord {
  name: string
  args: unknown
  ok: boolean
  /** Short, human-readable outcome for a client timeline. */
  summary: string
}

/** Source text the agent read during a turn, pinned to the commit it was read at. */
export interface EvidenceRecord {
  id: string
  entityId: string
  commitSha: string
  path: string
  /** 0-based inclusive start and exclusive end lines of the excerpt. */
  startLine: number
  endLine: number
  excerpt: string
}

export interface TurnRecord {
  id: string
  projectId: string
  threadId: string
  model: string
  status: TurnStatus
  graph: GraphRef
  selection: SelectionResolution
  startedAt: string
  finishedAt?: string
  toolCalls: ToolCallRecord[]
  evidence: EvidenceRecord[]
  proposalId?: string
  correctionId?: string
  /** The agent's final message to the developer. */
  reply?: string
  error?: string
}

export interface ProposalPreview {
  /** Draft revision the proposal was validated against, and the revision approval produces. */
  baseRevision: number
  resultRevision: number
  components: { id: string; name: string; change: 'added' | 'updated' | 'removed' }[]
  connections: {
    id: string
    kind: CatalogEdge['kind']
    from: string
    to: string
    change: 'added' | 'removed'
  }[]
}

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'stale'

export interface Proposal {
  id: string
  projectId: string
  threadId: string
  turnId: string
  summary: string
  patch: CatalogPatch
  preview: ProposalPreview
  evidence: EvidenceRecord[]
  status: ProposalStatus
  createdAt: string
  decidedAt?: string
  /** Why it was rejected or went stale. */
  reason?: string
  /** Set on approval. */
  intentId?: string
}

/**
 * What the developer approved, frozen at approval time. This is the hand-off to a coding run and
 * stays unchanged through corrections, so a verifier can always check against the original intent.
 */
export interface ApprovedIntent {
  id: string
  projectId: string
  threadId: string
  proposalId: string
  summary: string
  repository: { id: number; fullName: string }
  commitSha: string
  fromRevision: number
  toRevision: number
  operations: CatalogOperation[]
  preview: ProposalPreview
  evidence: EvidenceRecord[]
  /** Source locations of every affected component and connection in the approved draft. */
  sources: { entityId: string; sources: CatalogSource[] }[]
  approvedAt: string
}

/** Verification outcome for one coding candidate. Produced by the coding/verification service. */
export interface VerificationReport {
  intentId: string
  runId: string
  status: 'passed' | 'failed' | 'error'
  checks: { name: string; passed: boolean; detail?: string }[]
  diff?: string
  at: string
}

/** The design agent's request to correct a coding candidate. The intent it points at is unchanged. */
export interface CorrectionRequest {
  id: string
  projectId: string
  threadId: string
  turnId: string
  intentId: string
  runId: string
  failedChecks: string[]
  instructions: string
  createdAt: string
}

export interface DraftState {
  repository: { id: number; fullName: string }
  commitSha: string
  revision: number
  graph: CatalogGraph
  /** One entry per approved proposal, oldest first. */
  history: { revision: number; proposalId: string; intentId: string; at: string }[]
}

/** Everything a client needs to reopen a project and show where work stands. */
export interface ProjectState {
  projectId: string
  draft: DraftState | null
  proposals: Proposal[]
  intents: ApprovedIntent[]
  corrections: CorrectionRequest[]
  turns: TurnRecord[]
}

export type ApprovalResult =
  | { ok: true; draft: DraftState; intent: ApprovedIntent; alreadyApproved: boolean }
  | {
      ok: false
      code: 'not-found' | 'stale' | 'rejected' | 'invalid'
      message: string
      proposal?: Proposal
      currentRevision?: number
      issue?: { code: CatalogIssueCode; message: string }
    }
