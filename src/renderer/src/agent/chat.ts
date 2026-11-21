/**
 * Pure model for the design chat: what the transcript shows and what a send carries. No IPC here,
 * so it is tested directly (test/agent/chat.test.ts).
 */
import type {
  DesignTurnInput,
  DraftState,
  EvidenceRecord,
  Proposal,
  ProjectState,
  TurnRecord
} from '../../../shared/design'
import type { ThreadEvent } from '../../../shared/threads'

/**
 * Selectable design models. Mirrors `DESIGN_MODELS` in src/main/design/index.ts: the bridge does
 * not list them yet, and the backend rejects any ID it does not offer.
 */
export const DESIGN_MODELS = ['gemini-4-carbon', 'gemini-4-hydrogen'] as const

/** One developer turn: the message, what the agent did, its reply, and any proposal. */
export interface TurnItem {
  kind: 'turn'
  key: string
  at: string
  /** Null when the turn never reached history (e.g. `stale-graph`) and no local copy exists. */
  text: string | null
  reply: string | null
  turn: TurnRecord | null
  proposal: Proposal | null
}

/** Workflow notes posted to the thread: run started, verdict recorded, decision needed. */
export interface NoteItem {
  kind: 'note'
  key: string
  at: string
  text: string
}

export type TranscriptItem = TurnItem | NoteItem

/** The design harness writes history events as `turn:<turnId>:developer|assistant`. */
const TURN_EVENT = /^turn:(.+):(developer|assistant)$/

export function buildTranscript(
  events: ThreadEvent[],
  project: Pick<ProjectState, 'turns' | 'proposals'> | null,
  threadId: string,
  /** Messages sent from this window, by turn ID, for turns that never reached history. */
  sent: Record<string, string> = {}
): TranscriptItem[] {
  const turns = new Map(
    (project?.turns ?? []).filter((t) => t.threadId === threadId).map((t) => [t.id, t])
  )
  const proposals = new Map((project?.proposals ?? []).map((p) => [p.id, p]))
  const byTurn = new Map<string, TurnItem>()
  const notes: NoteItem[] = []

  const item = (turnId: string, at: string): TurnItem => {
    let entry = byTurn.get(turnId)
    if (!entry) {
      const turn = turns.get(turnId) ?? null
      entry = {
        kind: 'turn',
        key: turnId,
        at,
        text: sent[turnId] ?? null,
        reply: null,
        turn,
        proposal: (turn?.proposalId && proposals.get(turn.proposalId)) || null
      }
      byTurn.set(turnId, entry)
    }
    return entry
  }

  for (const e of events) {
    const match = TURN_EVENT.exec(e.id)
    if (e.type === 'user_message') item(match?.[1] ?? e.id, e.at).text = e.text
    else if (e.type === 'assistant_message') item(match?.[1] ?? e.id, e.at).reply = e.text
    else if (e.type === 'reference')
      notes.push({ kind: 'note', key: e.id, at: e.at, text: e.note ?? 'Linked work updated' })
  }
  // Turns with no history events, such as a send against a stale draft.
  for (const t of turns.values()) if (!byTurn.has(t.id)) item(t.id, t.startedAt)

  return [...byTurn.values(), ...notes].sort((a, b) => a.at.localeCompare(b.at))
}

export type SelectionCheck =
  | { status: 'none' }
  | { status: 'ok'; componentId: string; name: string; kind: string }
  | { status: 'missing'; componentId: string; label: string }

/** Whether the canvas selection is a component of the working draft the turn will run against. */
export function checkSelection(
  draft: DraftState | null,
  selected: { componentId: string; label: string } | null
): SelectionCheck {
  if (!selected) return { status: 'none' }
  const node = draft?.graph.nodes.find((n) => n.id === selected.componentId)
  return node
    ? { status: 'ok', componentId: node.id, name: node.name, kind: node.kind }
    : { status: 'missing', componentId: selected.componentId, label: selected.label }
}

/** The design turn for a send. Selection is attached only when it exists in the draft. */
export function turnInput(args: {
  projectId: string
  threadId: string
  model: string
  draft: DraftState
  message: string
  selection: SelectionCheck
}): DesignTurnInput {
  const { draft, selection } = args
  return {
    projectId: args.projectId,
    threadId: args.threadId,
    model: args.model,
    graph: {
      repositoryId: draft.repository.id,
      commitSha: draft.commitSha,
      revision: draft.revision
    },
    message: args.message.trim(),
    ...(selection.status === 'ok' && { selectedComponentId: selection.componentId })
  }
}

/** Running turn of a thread, if the backend has one in flight. */
export const runningTurn = (project: ProjectState | null, threadId: string): TurnRecord | null =>
  project?.turns.find((t) => t.threadId === threadId && t.status === 'running') ?? null

export const TURN_STATUS_LABEL: Record<TurnRecord['status'], string> = {
  running: 'Running',
  'awaiting-approval': 'Awaiting approval',
  completed: 'Done',
  cancelled: 'Cancelled',
  failed: 'Failed',
  interrupted: 'Interrupted',
  'stale-graph': 'Stale draft'
}

/** Design-system tone per status: ok = moss, warn = label yellow, danger = poppy, info = steel. */
export const TURN_STATUS_TONE: Record<TurnRecord['status'], 'ok' | 'warn' | 'danger' | 'info'> = {
  running: 'info',
  'awaiting-approval': 'warn',
  completed: 'ok',
  cancelled: 'info',
  failed: 'danger',
  interrupted: 'warn',
  'stale-graph': 'warn'
}

/** Pending proposals validated against an older revision will be refused on approve. */
export const proposalIsBehind = (proposal: Proposal, draft: DraftState | null): boolean =>
  proposal.status === 'pending' && !!draft && proposal.preview.baseRevision !== draft.revision

/** Short verbs for the design harness's tools (src/main/design/tools.ts). Unknown names show as-is. */
const TOOL_LABEL: Record<string, string> = {
  inspect_component: 'Inspect',
  follow_connections: 'Follow',
  read_source: 'Read',
  propose_graph_edit: 'Propose',
  read_verification: 'Verify',
  request_correction: 'Correct'
}

export interface TraceStep {
  key: string
  tool: string
  label: string
  ok: boolean
  /** The backend's own one-line outcome, e.g. `Read src/retry.ts:12-40`. */
  summary: string
  /** Tool arguments as recorded, for the tooltip. */
  args: string
}

export interface ActivityTrace {
  /** working: the turn is in flight · done: it finished · stopped: failed, cancelled or interrupted. */
  phase: 'working' | 'done' | 'stopped'
  headline: string
  steps: TraceStep[]
  evidence: EvidenceRecord[]
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The activity a turn actually recorded: its tool calls, in order, and the source it read.
 * `turn` is null while the send is in flight and the backend has not saved the turn yet.
 * Nothing is inferred; a turn with no recorded activity has no steps.
 */
export function activityTrace(turn: TurnRecord | null): ActivityTrace {
  const steps: TraceStep[] = (turn?.toolCalls ?? []).map((c, i) => ({
    key: `${i}`,
    tool: c.name,
    label: TOOL_LABEL[c.name] ?? c.name,
    ok: c.ok,
    summary: c.summary,
    args: JSON.stringify(c.args) ?? ''
  }))
  const evidence = turn?.evidence ?? []
  const failed = steps.filter((s) => !s.ok).length
  const counts = [
    plural(steps.length, 'tool call'),
    ...(evidence.length ? [plural(evidence.length, 'source')] : []),
    ...(failed ? [`${failed} failed`] : [])
  ].join(' · ')

  if (!turn) return { phase: 'working', headline: 'Starting the turn…', steps, evidence }
  if (turn.status === 'running')
    return {
      phase: 'working',
      headline: steps.length ? `Working · ${counts}` : 'Working · no tool calls yet',
      steps,
      evidence
    }
  if (['failed', 'cancelled', 'interrupted'].includes(turn.status))
    return {
      phase: 'stopped',
      headline: `${TURN_STATUS_LABEL[turn.status]} after ${counts}`,
      steps,
      evidence
    }
  return { phase: 'done', headline: counts, steps, evidence }
}
