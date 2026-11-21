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

/** A GitHub repository and the branch to read. */
export interface RepoRef {
  /** GitHub repo ID. When set and the repo is indexed, the index is used as evidence. */
  id?: number
  fullName: string
  branch: string
}

export interface RepoGraph {
  graph: CurrentGraph
  /** Repo-relative paths of the files Gemini read. */
  files: string[]
}

/**
 * The app canvas: how the app runs, in the four shapes an engineer would sketch on a whiteboard.
 * screen: a page or window the user sees. logic: code that decides things. service: a third party
 * or backend the app calls (auth, payments, an API). data: a database or store, with its tables.
 */
export const flowKinds = ['screen', 'logic', 'service', 'data'] as const
export type FlowKind = (typeof flowKinds)[number]

export interface FlowBox {
  id: string
  kind: FlowKind
  /** What an engineer would call it on a whiteboard, e.g. "Word guess logic". */
  name: string
  /** One plain sentence: what it does. */
  summary: string
  /** Tables or collections, for data boxes. */
  tables: string[]
  /** Repo-relative files that show it exists. */
  paths: string[]
}

export interface FlowLink {
  id: string
  from: string
  to: string
  /** A few words, e.g. "saves score". Empty when the arrow says enough. */
  label: string
}

export interface AppFlow {
  boxes: FlowBox[]
  links: FlowLink[]
}

// ponytail: only diagrams.ts's architectureDiagram still uses these; delete both together.
export const componentTypes = [
  'service',
  'frontend',
  'worker',
  'database',
  'cache',
  'queue',
  'storage',
  'auth',
  'external-api',
  'hosting',
  'ci',
  'module',
  'other'
] as const
export interface ArchitectureGraph {
  components: {
    id: string
    type: (typeof componentTypes)[number]
    label: string
    detail: string
    paths: string[]
  }[]
  connections: { id: string; from: string; to: string; label: string }[]
}

/** A rectangle in window CSS pixels. */
export interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ManagedAgentResult {
  diff: string
  tests: {
    name: string
    passed: boolean
    /** Acceptance check ID, for checks derived from the diagram. */
    id?: string
    /** What the agent's check observed, or why the check counted as failed. */
    detail?: string
  }[]
  /** Source files the agent changed, not counting its checks script. */
  changedFiles?: string[]
  /** `fixture`: the bundled retry checks. `diagram`: checks derived from the approved edits. */
  checks?: 'fixture' | 'diagram'
}

/** An approved change to hand to the managed agent. */
export interface ManagedChangeRequest {
  /** The graph before any of the approved edits. */
  graph: CurrentGraph
  /** Approved edits, in the order they were applied. */
  edits: ProposedEdit[]
  /** The repo the graph came from. Absent for the bundled example. */
  repo?: RepoRef
}

export interface DiogenesApi {
  gemini: {
    /** The bundled background-job fixture. */
    buildCurrentGraph(): Promise<CurrentGraph>
    /** Check later proposals against the fixture files again, without calling Gemini. */
    useFixture(): Promise<void>
    /** Finds the main state machine in a repo. Later proposals are checked against its files. */
    buildRepoGraph(repo: RepoRef): Promise<RepoGraph>
    /** The app canvas, inferred by Gemini from the index, file tree, manifests and schemas. */
    buildAppFlow(repo: RepoRef): Promise<AppFlow>
    proposeEdit(graph: CurrentGraph, png: Uint8Array): Promise<ProposalResult>
    runManagedRetry(graph: CurrentGraph, proposal: ProposedEdit): Promise<ManagedAgentResult>
    /**
     * Any approved change: the agent implements it and is verified against acceptance checks
     * derived from the edits. The bundled retry-once example keeps its own fixed checks.
     */
    runManagedChange(request: ManagedChangeRequest): Promise<ManagedAgentResult>
  }
  canvas: {
    /** Screenshots part of the window, for sending canvas markup to Gemini. */
    capture(rect: CaptureRect): Promise<Uint8Array>
  }
}

export const geminiChannels = {
  buildCurrentGraph: 'gemini:build-current-graph',
  useFixture: 'gemini:use-fixture',
  buildRepoGraph: 'gemini:build-repo-graph',
  buildAppFlow: 'gemini:build-app-flow',
  proposeEdit: 'gemini:propose-edit',
  runManagedRetry: 'gemini:run-managed-retry',
  runManagedChange: 'gemini:run-managed-change',
  capture: 'canvas:capture'
} as const
