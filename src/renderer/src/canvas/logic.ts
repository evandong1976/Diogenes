import type { CurrentGraph, ManagedAgentResult, ProposedEdit } from '../../../shared/gemini'
import example from '../../../../fixtures/background-job/example.json'

// Saved Gemini responses, so the canvas works without an API key.
export const exampleGraph = example.currentGraph as CurrentGraph
export const exampleEdit = example.proposedEdit as ProposedEdit

export interface LogicState {
  graph: CurrentGraph
  /** Where the graph came from, shown in the toolbar. */
  source: string
  isExample: boolean
  approved?: { graph: CurrentGraph; edit: ProposedEdit }
  managed?:
    | { kind: 'running' }
    | { kind: 'done'; result: ManagedAgentResult }
    | { kind: 'error'; message: string }
  /** Bumped on every change so the view refits. */
  version: number
}

export const initialLogic: LogicState = {
  graph: exampleGraph,
  source: 'Saved example · background job',
  isExample: true,
  version: 0
}
