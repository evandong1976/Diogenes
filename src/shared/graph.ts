import type { CurrentGraph, ProposedEdit } from './gemini'

/**
 * Apply an accepted edit to a copy of the graph, as described in agents/tool-catalog.md:
 * remove `replaceTransitionId`, then append `addStates` and `addTransitions`.
 * New items have no source references until the coding agent implements them.
 */
export function applyEdit(graph: CurrentGraph, edit: ProposedEdit): CurrentGraph {
  return {
    initialStateId: graph.initialStateId,
    states: [...graph.states, ...edit.addStates.map((s) => ({ ...s, sources: [] }))],
    transitions: [
      ...graph.transitions.filter((t) => t.id !== edit.replaceTransitionId),
      ...edit.addTransitions.map((t) => ({ ...t, sources: [] }))
    ]
  }
}
