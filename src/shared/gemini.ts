export interface SourceReference {
  path: string
  startLine: number
  endLine: number
}

export interface GraphState {
  id: string
  label: string
}

export interface GraphTransition {
  id: string
  from: string
  to: string
  trigger: string
}

export interface CurrentGraph {
  initialStateId: string
  states: (GraphState & { sources: SourceReference[] })[]
  transitions: (GraphTransition & { sources: SourceReference[] })[]
}

export interface ProposedEdit {
  kind: 'edit'
  summary: string
  replaceTransitionId: string
  addStates: GraphState[]
  addTransitions: GraphTransition[]
}

export type ProposalResult = ProposedEdit | { kind: 'clarification'; question: string }

export interface DiogenesApi {
  gemini: {
    buildCurrentGraph(): Promise<CurrentGraph>
    proposeEdit(graph: CurrentGraph, png: Uint8Array): Promise<ProposalResult>
  }
}

export const geminiChannels = {
  buildCurrentGraph: 'gemini:build-current-graph',
  proposeEdit: 'gemini:propose-edit'
} as const
