/**
 * Pure model for the Coding tab: which handoff it shows, where the run stands, and what the
 * provider said versus what local verification found. No IPC, so it is tested directly.
 *
 * The provider's `completed` only means a candidate is ready to collect. Nothing here reports a
 * pass unless the local verdict for that exact candidate passed.
 */
import type {
  ApprovalRecord,
  HandoffRecord,
  ObligationVerdict,
  Outcome,
  RunEvent,
  RunRecord
} from '../../../shared/workflow'

/** One approval the tab can open, with its newest handoff once coding started. */
export interface CodingEntry {
  approvalId: string
  label: string
  handoff: HandoffRecord | null
}

export function codingEntries(
  approvals: ApprovalRecord[],
  handoffs: HandoffRecord[]
): CodingEntry[] {
  return approvals
    .map((a) => ({
      approvalId: a.approvalId,
      label: a.packet.requiredChanges[0] ?? a.packet.targetComponentId,
      handoff: handoffs.findLast((h) => h.approvalId === a.approvalId) ?? null
    }))
    .sort((a, b) => updated(b).localeCompare(updated(a)))
}

const updated = (e: CodingEntry): string => e.handoff?.updatedAt ?? ''

/** The focused approval if it is listed, otherwise the most recently active one. */
export function selectEntry(entries: CodingEntry[], focus: string | null): CodingEntry | null {
  return entries.find((e) => e.approvalId === focus) ?? entries[0] ?? null
}

export type StepState = 'done' | 'current' | 'failed' | 'todo'
export interface Step {
  key: 'handoff' | 'coding' | 'verifying' | 'result'
  label: string
  state: StepState
}

const RESULT_LABEL: Record<HandoffRecord['stage'], string> = {
  coding: 'Result',
  verifying: 'Result',
  accepted: 'Verified',
  correctable: 'Checks failed',
  'needs-decision': 'Needs review',
  closed: 'Closed'
}

/** Handoff → coding agent → local checks → result, for the newest attempt. */
export function codingSteps(handoff: HandoffRecord | null): Step[] {
  const stage = handoff?.stage
  const order = !handoff ? 0 : stage === 'coding' ? 1 : stage === 'verifying' ? 2 : 3
  const bad = stage === 'correctable' || stage === 'needs-decision'
  const steps: Step[] = [
    { key: 'handoff', label: 'Handoff', state: 'todo' },
    { key: 'coding', label: 'Coding agent', state: 'todo' },
    { key: 'verifying', label: 'Local checks', state: 'todo' },
    { key: 'result', label: stage ? RESULT_LABEL[stage] : 'Result', state: 'todo' }
  ]
  return steps.map((s, i) => ({
    ...s,
    state:
      i < order
        ? 'done'
        : i > order
          ? 'todo'
          : i === 3 && bad
            ? 'failed'
            : i === 3 && stage !== 'closed'
              ? 'done'
              : 'current'
  }))
}

export type Tone = 'ok' | 'warn' | 'danger' | 'info'

/** What the managed agent reported about its own turn. Never a verdict. */
export function providerLine(run: RunRecord | undefined): { text: string; tone: Tone } {
  if (!run) return { text: 'Not started', tone: 'info' }
  const { status, remoteStatus } = run.run
  const raw = remoteStatus && remoteStatus !== status ? ` (${remoteStatus})` : ''
  if (status === 'completed')
    return {
      text: run.candidate
        ? `Completed${raw} · candidate collected, not a verdict`
        : run.candidateRejected
          ? `Completed${raw} · candidate rejected`
          : `Completed${raw} · collecting candidate`,
      tone: run.candidateRejected ? 'danger' : 'info'
    }
  if (status === 'failed') return { text: `Failed${raw}`, tone: 'danger' }
  if (status === 'cancelled') return { text: `Cancelled${raw}`, tone: 'warn' }
  return { text: `${status === 'queued' ? 'Queued' : 'Working'}${raw}`, tone: 'info' }
}

/** What Diogenes found when it checked the exact candidate itself. */
export function localLine(run: RunRecord | undefined): { text: string; tone: Tone } {
  const verdict = run?.verdict
  if (!verdict || verdict.candidateId !== run?.candidate?.candidateId)
    return { text: run?.candidate ? 'Checking the candidate…' : 'Not run yet', tone: 'info' }
  if (verdict.invalid) return { text: `Refused: ${verdict.invalid}`, tone: 'danger' }
  const fails = verdict.obligations.filter((o) => o.outcome === 'fail').length
  const unknown = verdict.obligations.filter((o) => o.outcome === 'unknown').length
  if (verdict.overall === 'pass')
    return {
      text: `Passed ${verdict.obligations.length} of ${verdict.obligations.length}`,
      tone: 'ok'
    }
  return {
    text: [fails && `${fails} failed`, unknown && `${unknown} unknown`].filter(Boolean).join(' · '),
    tone: fails ? 'danger' : 'warn'
  }
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  pass: 'Pass',
  fail: 'Fail',
  unknown: 'Unknown'
}
export const OUTCOME_TONE: Record<Outcome, Tone> = { pass: 'ok', fail: 'danger', unknown: 'warn' }

/** Evidence for why the newest attempt did not pass, in the order a reader needs it. */
export function failureEvidence(handoff: HandoffRecord, run: RunRecord | undefined): string[] {
  const lines: string[] = []
  if (run?.run.error) lines.push(run.run.error)
  if (run?.candidateRejected) lines.push(run.candidateRejected)
  for (const o of run?.verdict?.obligations ?? [])
    if (o.outcome !== 'pass') lines.push(obligationEvidence(o))
  if (handoff.decision) lines.push(handoff.decision.detail)
  return lines
}

const obligationEvidence = (o: ObligationVerdict): string =>
  `${o.id} · ${OUTCOME_LABEL[o.outcome]}${o.unknownReason ? ` (${o.unknownReason})` : ''}: ${o.diagnostic ?? o.scope}`

/** Trace rows: shell commands and their output stay readable; prose stays prose. */
export type TraceRow =
  | { key: string; kind: 'command'; text: string }
  | { key: string; kind: 'output'; text: string; long: boolean }
  | { key: string; kind: 'message' | 'steer' | 'error' | 'status'; text: string }

export function traceRows(events: RunEvent[]): TraceRow[] {
  return events.map((e, i) => {
    const key = `${i}`
    if (e.kind === 'tool' && e.shell === 'output')
      return { key, kind: 'output', text: e.text, long: e.text.split('\n').length > 8 }
    if (e.kind === 'tool') return { key, kind: 'command', text: e.text }
    return { key, kind: e.kind, text: e.text }
  })
}
