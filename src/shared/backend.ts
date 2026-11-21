/**
 * Project-scoped backend surface shared by main, preload and headless clients.
 *
 * Every call names its `projectId` (the GitHub repository ID as a string). The main process
 * checks that the signed-in GitHub account can read that repository before it reads or writes
 * anything, and every thread, turn, proposal, approval, handoff and run ID is resolved inside
 * that project only. An ID from another project is reported as not found.
 */
import type { CatalogPatchResult } from './catalog'
import type { CodingRunSummary, CodingRunView } from './codingRun'
import type { ApprovalResult, DesignTurnInput, ProjectState, Proposal, TurnRecord } from './design'
import type {
  CreateThreadInput,
  ThreadEvent,
  ThreadKind,
  ThreadSnapshot,
  ThreadSummary
} from './threads'
import type {
  ApprovalRecord,
  ApprovalRequest,
  CorrectionRequest,
  DecisionOption,
  HandoffRecord,
  ProjectWorkflowState,
  Verdict
} from './workflow'

export interface BackendStatus {
  /** `postgres` whenever DIOGENES_DATABASE_URL is set; there is no fallback from it. */
  storage: 'postgres' | 'files'
  schemaVersion: number | null
}

export interface DesignApproval {
  design: ApprovalResult
  /** The frozen, immutable approval the coding handoff starts from. */
  approval: ApprovalRecord | null
  /** Why no approval could be frozen, e.g. a change shape no local verifier supports. */
  approvalError?: string
}

export interface DesignTurnResult {
  turn: TurnRecord
  /** Set when the turn asked for a correction and the workflow accepted it. */
  handoff?: HandoffRecord
  correctionError?: string
}

export type RecordedVerdict = Verdict & { verdictId: string }

export interface BackendApi {
  status(): Promise<BackendStatus>
  threads: {
    create(projectId: string, input: CreateThreadInput): Promise<ThreadSummary>
    list(projectId: string, filter?: { kind?: ThreadKind }): Promise<ThreadSummary[]>
    open(projectId: string, threadId: string): Promise<ThreadSnapshot>
    eventsSince(projectId: string, threadId: string, afterSeq: number): Promise<ThreadEvent[]>
  }
  design: {
    openProject(projectId: string): Promise<ProjectState>
    getProject(projectId: string): Promise<ProjectState>
    startTurn(input: DesignTurnInput): Promise<DesignTurnResult>
    cancelTurn(projectId: string, turnId: string): Promise<boolean>
    reject(projectId: string, proposalId: string, reason?: string): Promise<Proposal>
    /** Approves against `expectedRevision`, then freezes the approval. Repeats are idempotent. */
    approve(
      projectId: string,
      proposalId: string,
      expectedRevision: number
    ): Promise<DesignApproval>
  }
  workflow: {
    preview(request: Pick<ApprovalRequest, 'baseline' | 'patch'>): Promise<CatalogPatchResult>
    getProject(projectId: string): Promise<ProjectWorkflowState>
    startHandoff(projectId: string, approvalId: string): Promise<HandoffRecord>
    getHandoff(projectId: string, handoffId: string): Promise<HandoffRecord | null>
    refresh(projectId: string, handoffId: string): Promise<HandoffRecord>
    steer(projectId: string, handoffId: string, message: string): Promise<HandoffRecord>
    cancel(projectId: string, handoffId: string): Promise<HandoffRecord>
    requestCorrection(
      projectId: string,
      handoffId: string,
      request: Pick<CorrectionRequest, 'obligationIds' | 'instructions'>
    ): Promise<HandoffRecord>
    resolveDecision(
      projectId: string,
      handoffId: string,
      option: DecisionOption
    ): Promise<HandoffRecord>
    /** Every recorded verification result for a handoff, oldest first. */
    verdicts(projectId: string, handoffId: string): Promise<RecordedVerdict[]>
  }
  coding: {
    list(projectId: string): Promise<CodingRunSummary[]>
    status(projectId: string, runId: string): Promise<CodingRunView>
    /** Resends the latest turn of an `uncertain` run. Never automatic. */
    retry(projectId: string, runId: string): Promise<CodingRunView>
  }
}

export const backendChannels = {
  status: 'backend:status',
  threadsCreate: 'backend:threads:create',
  threadsList: 'backend:threads:list',
  threadsOpen: 'backend:threads:open',
  threadsEventsSince: 'backend:threads:eventsSince',
  designOpenProject: 'backend:design:openProject',
  designGetProject: 'backend:design:getProject',
  designStartTurn: 'backend:design:startTurn',
  designCancelTurn: 'backend:design:cancelTurn',
  designReject: 'backend:design:reject',
  designApprove: 'backend:design:approve',
  workflowPreview: 'backend:workflow:preview',
  workflowGetProject: 'backend:workflow:getProject',
  workflowStartHandoff: 'backend:workflow:startHandoff',
  workflowGetHandoff: 'backend:workflow:getHandoff',
  workflowRefresh: 'backend:workflow:refresh',
  workflowSteer: 'backend:workflow:steer',
  workflowCancel: 'backend:workflow:cancel',
  workflowRequestCorrection: 'backend:workflow:requestCorrection',
  workflowResolveDecision: 'backend:workflow:resolveDecision',
  workflowVerdicts: 'backend:workflow:verdicts',
  codingList: 'backend:coding:list',
  codingStatus: 'backend:coding:status',
  codingRetry: 'backend:coding:retry'
} as const
