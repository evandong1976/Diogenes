/**
 * Project threads: durable design and coding conversations owned by the main process.
 *
 * A thread's identity (`ThreadId`) is local to Diogenes and never changes. Provider identity
 * (Gemini interaction IDs, managed-agent environments) lives in `ThreadProviderState`, outside
 * the visible transcript, so a model switch or an expired environment changes status without
 * touching history. Events reference domain objects by ID; their owning services report the
 * latest state of those objects.
 */

export type ThreadKind = 'design' | 'coding'

/** `thr_` followed by a UUID. Assigned by the store unless the caller supplies one on create. */
export type ThreadId = string

/** Path-safe project key, e.g. a GitHub repository ID as a string. */
export type ProjectId = string

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** A pointer to a domain object owned by another service. The store never resolves these. */
export type WorkRef =
  | { kind: 'draftRevision'; draftId: string; revision: number }
  | { kind: 'proposal'; proposalId: string }
  | { kind: 'handoff'; handoffId: string }
  | { kind: 'codingRun'; runId: string }
  | { kind: 'verdict'; verdictId: string }

/** Presentation context a client attached to a user turn, e.g. the selected component. */
export interface TurnContext {
  selectedComponentIds?: string[]
}

export type ThreadEventBody =
  | { type: 'user_message'; text: string; context?: TurnContext }
  | { type: 'assistant_message'; text: string; model?: string }
  | { type: 'tool_call'; callId: string; name: string; args: JsonValue }
  | { type: 'tool_result'; callId: string; name: string; ok: boolean; result: JsonValue }
  /** A standalone link to work, e.g. "handoff approved" or "coding run started". */
  | { type: 'reference'; note?: string }

export type ThreadEventInput = ThreadEventBody & {
  /**
   * Idempotency key. Callers that may retry must supply it: appending the same ID with the
   * same content returns the stored event; the same ID with different content is rejected.
   */
  id?: string
  refs?: WorkRef[]
}

export type ThreadEvent = ThreadEventBody & {
  id: string
  /** 1-based position in the thread. Gapless and never reused. */
  seq: number
  at: string
  refs?: WorkRef[]
}

export type ProviderStatus =
  /** No provider session yet, or the client deliberately started fresh. */
  | 'none'
  | 'active'
  /** The provider can no longer continue (interaction retention or environment expired). */
  | 'expired'
  | 'failed'
  | 'ended'

/** Provider continuation metadata. Not part of the transcript and never sent to the renderer as history. */
export interface ThreadProviderState {
  provider: 'gemini'
  status: ProviderStatus
  model?: string
  /** Last Gemini interaction ID, used as `previous_interaction_id` on the next turn. */
  interactionId?: string
  /** Managed-agent environment, resumable via `environment_id` until it expires. */
  environmentId?: string
  detail?: string
  updatedAt: string
}

export interface ThreadSummary {
  projectId: ProjectId
  id: ThreadId
  kind: ThreadKind
  title: string
  createdAt: string
  updatedAt: string
  /** Seq of the last event; 0 when empty. Use it as `afterSeq` to pick up later updates. */
  lastSeq: number
  provider: ThreadProviderState | null
}

export interface ThreadSnapshot extends ThreadSummary {
  events: ThreadEvent[]
}

export interface CreateThreadInput {
  kind: ThreadKind
  title?: string
  /** Optional client-chosen ID; creating an existing ID with the same kind returns it unchanged. */
  id?: ThreadId
}

export interface AppendOptions {
  /** Reject with `stale` unless the thread's `lastSeq` equals this value. */
  expectedLastSeq?: number
}

export interface AppendResult {
  thread: ThreadSummary
  /** One entry per input, in input order: the new or previously stored event. */
  events: ThreadEvent[]
  /** True per input when it matched an already-stored event (a retry). */
  duplicate: boolean[]
}

export type ThreadErrorCode = 'invalid' | 'not_found' | 'stale' | 'conflict'

/** Emitted after every committed change. Fetch details with `eventsSince` or `open`. */
export interface ThreadChange {
  projectId: ProjectId
  threadId: ThreadId
  lastSeq: number
  /** Events committed by this change; empty for provider-only or create changes. */
  events: ThreadEvent[]
  thread: ThreadSummary
}
