// Acceptance checks for an approved change, derived from the diagram itself.
// The verifier runs these against the edited code, so what the user approved on the canvas is
// what gets tested.

import type { CurrentGraph, GraphTransition, ProposedEdit } from './gemini'
import { applyEdit } from './graph'

export type CheckKind = 'added' | 'removed' | 'kept'

export interface AcceptanceCheck {
  /** Stable ID the reporter matches results by: `<kind>:<from>-><to>`. */
  id: string
  kind: CheckKind
  from: string
  to: string
  trigger: string
  /** One sentence, in diagram terms, that the agent's test must establish. */
  description: string
}

/** Unchanged transitions to re-check, so the edit can't quietly break the rest of the machine. */
const MAX_KEPT = 6

/**
 * Checks for applying `edits` in order to `base`. A transition both added and later removed is
 * dropped; one replaced and re-added keeps only its final form.
 */
export function checksFromEdits(base: CurrentGraph, edits: ProposedEdit[]): AcceptanceCheck[] {
  const label = new Map<string, string>()
  const remember = (g: CurrentGraph): void => g.states.forEach((s) => label.set(s.id, s.label))
  remember(base)

  let graph = base
  const removed = new Map<string, GraphTransition>()
  const added = new Map<string, GraphTransition>()
  for (const edit of edits) {
    const target = graph.transitions.find((t) => t.id === edit.replaceTransitionId)
    if (target) {
      if (added.has(target.id)) added.delete(target.id)
      else removed.set(target.id, target)
    }
    for (const t of edit.addTransitions) {
      if (removed.has(t.id)) removed.delete(t.id)
      added.set(t.id, t)
    }
    graph = applyEdit(graph, edit)
    remember(graph)
  }

  const name = (id: string): string => label.get(id) ?? id
  const changed = new Set([...removed.keys(), ...added.keys()])
  const kept = base.transitions.filter((t) => !changed.has(t.id)).slice(0, MAX_KEPT)

  const check = (kind: CheckKind, t: GraphTransition, description: string): AcceptanceCheck => ({
    id: `${kind}:${t.id}`,
    kind,
    from: t.from,
    to: t.to,
    trigger: t.trigger,
    description
  })

  return [
    ...[...added.values()].map((t) =>
      check('added', t, `From ${name(t.from)}, when ${t.trigger}, it moves to ${name(t.to)}.`)
    ),
    ...[...removed.values()].map((t) =>
      check(
        'removed',
        t,
        `From ${name(t.from)}, it no longer moves straight to ${name(t.to)} when ${t.trigger}.`
      )
    ),
    ...kept.map((t) =>
      check('kept', t, `Still: from ${name(t.from)}, when ${t.trigger}, it moves to ${name(t.to)}.`)
    )
  ]
}

/** Whether an approved change is the bundled example's retry-once edit, which has its own checks. */
export function isRetryOnceExample(edits: ProposedEdit[]): boolean {
  if (edits.length !== 1) return false
  const [edit] = edits
  if (edit.replaceTransitionId !== 'running->failed' || edit.addStates.length !== 1) return false
  const retry = edit.addStates[0].id
  const expected = [`running->${retry}`, `${retry}->succeeded`, `${retry}->failed`]
  return (
    edit.addTransitions.length === 3 &&
    expected.every((id) => edit.addTransitions.some((t) => t.id === id))
  )
}
