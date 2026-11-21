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
    .map(({ approvalId, packet }) => {
      const summary = packet.kind === 'catalog' ? packet.plan?.summary : undefined
      return {
        approvalId,
        label:
          summary ??
          packet.requiredChanges[0]?.replace(/ is connected$/, '') ??
          packet.targetComponentId,
        handoff: handoffs.findLast((h) => h.approvalId === approvalId) ?? null
      }
    })
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
  return events.flatMap((e, i): TraceRow[] => {
    const key = `${i}`
    if (e.text === 'thought') return []
    if (e.kind === 'tool' && e.shell === 'output')
      return [{ key, kind: 'output', text: e.text, long: e.text.split('\n').length > 8 }]
    if (e.kind === 'tool' && !e.shell) return [{ key, kind: 'status', text: e.text }]
    if (e.kind === 'tool') return [{ key, kind: 'command', text: e.text }]
    return [{ key, kind: e.kind, text: e.text }]
  })
}

/**
 * The activity one attempt produced. Steers and corrections continue the same managed run, so
 * the newest snapshot of that run holds every turn; this keeps the attempt's own turn. The
 * developer's direction is shown as the attempt's message, so steer events are left out.
 */
export function attemptEvents(handoff: HandoffRecord, run: RunRecord): RunEvent[] {
  const fresh = handoff.runs.findLast((r) => r.run.runId === run.run.runId) ?? run
  const turn = run.run.turn ?? 0
  return fresh.run.events.filter(
    (e) => e.kind !== 'steer' && (e.turn === undefined ? turn === 0 : e.turn === turn)
  )
}

/** A follow-up can go to the coding agent once its turn has ended and the handoff is open. */
export const canFollowUp = (handoff: HandoffRecord | null): boolean =>
  !!handoff && !['coding', 'verifying', 'closed'].includes(handoff.stage)

export const ORIGIN_LABEL: Record<NonNullable<RunRecord['origin']>, string> = {
  start: 'Handoff',
  correction: 'Correction',
  steer: 'Follow-up',
  retry: 'Retry'
}

const files = (n: number): string => `${n} file${n === 1 ? '' : 's'}`

/**
 * The assistant's own words after an attempt: what happened in the codebase and what the local
 * checks found. The agent finishing is stated separately from the verdict, never as a pass.
 */
export function replySummary(
  handoff: HandoffRecord,
  run: RunRecord
): { text: string; tone: Tone } | null {
  const { candidate, verdict, candidateRejected } = run
  const changed = candidate ? candidate.files.length + candidate.deleted.length : 0
  if (run.run.status === 'failed')
    return {
      text: `The coding agent stopped before finishing${run.run.error ? `: ${run.run.error}` : '.'}`,
      tone: 'danger'
    }
  if (run.run.status === 'cancelled') return { text: 'You stopped this turn.', tone: 'warn' }
  if (candidateRejected)
    return {
      text: `The coding agent finished, but I couldn't use its change: ${candidateRejected}`,
      tone: 'danger'
    }
  if (!candidate) return null
  if (!verdict || verdict.candidateId !== candidate.candidateId)
    return {
      text: `The coding agent finished and changed ${files(changed)}. Finishing doesn't accept it, so I'm checking the code locally now.`,
      tone: 'info'
    }
  const failed = verdict.obligations.filter((o) => o.outcome === 'fail').map((o) => o.id)
  const unknown = verdict.obligations.filter((o) => o.outcome === 'unknown').map((o) => o.id)
  if (verdict.overall === 'pass' && !verdict.invalid)
    return {
      text: `It changed ${files(changed)}, and I checked the result locally: all ${verdict.obligations.length} checks passed. The change matches the approved design and is ready to review.`,
      tone: 'ok'
    }
  const left = handoff.maxAttempts - handoff.runs.filter((r) => r.origin !== 'steer').length
  return {
    text: [
      `It changed ${files(changed)}, but the local checks don't confirm the design yet.`,
      failed.length ? `Failed: ${failed.join(', ')}.` : '',
      unknown.length ? `Couldn't confirm: ${unknown.join(', ')}.` : '',
      handoff.stage === 'correctable' && handoff.runs.at(-1) === run
        ? `The evidence is below; I can ask for a fix in this same handoff (${left} attempt${left === 1 ? '' : 's'} left), or you can follow up yourself.`
        : ''
    ]
      .filter(Boolean)
      .join(' '),
    tone: failed.length ? 'danger' : 'warn'
  }
}
