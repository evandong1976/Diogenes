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

/** Component types the architecture levels can show. Anything else is `other`. */
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
export type ComponentType = (typeof componentTypes)[number]

export interface ArchitectureComponent {
  id: string
  type: ComponentType
  label: string
  detail: string
  /** Repo-relative paths that show this component exists. */
  paths: string[]
}

export interface ArchitectureConnection {
  id: string
  from: string
  to: string
  label: string
}

export interface ArchitectureGraph {
  components: ArchitectureComponent[]
  connections: ArchitectureConnection[]
}

export interface Architecture {
  infrastructure: ArchitectureGraph
  integrations: ArchitectureGraph
  /** `files`: Gemini inferred this from the file list and manifests, not from the index. */
  evidence?: { source: 'files' }
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
    buildArchitecture(repo: RepoRef): Promise<Architecture>
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
  buildArchitecture: 'gemini:build-architecture',
  proposeEdit: 'gemini:propose-edit',
  runManagedRetry: 'gemini:run-managed-retry',
  runManagedChange: 'gemini:run-managed-change',
  capture: 'canvas:capture'
} as const
