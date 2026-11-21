// Types shared by main, preload, and renderer for the repository indexing slice.
// The graph format is Diogenes' own: SCIP is one source of evidence, not the schema.
// Future language indexers contribute nodes and edges in this same shape.

export const GRAPH_SCHEMA_VERSION = 1

/** 0-based line and character. Characters are UTF-16 code units (see `positionEncoding`). */
export type Position = { line: number; character: number }

/** A source range in a repo-relative file at the graph's commit. End is exclusive. */
export type SourceSpan = { path: string; start: Position; end: Position }

export type NodeKind =
  | 'file'
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'constructor'
  | 'property'
  | 'variable'
  | 'type'
  | 'enum'
  | 'namespace'
  | 'external'

export type GraphNode = {
  /**
   * Scoped, analyzer-independent ID.
   * `file:<path>` for files, `ts:<path>#<descriptor>` for symbols defined in the repo,
   * `ext:<manager>:<package>:<descriptor>` for symbols defined outside it.
   */
  id: string
  kind: NodeKind
  name: string
  /** Repo-relative path of the defining file. Absent for external symbols. */
  path?: string
  /** Span of the defining name. */
  span?: SourceSpan
  /** Span of the whole declaration. */
  extent?: SourceSpan
  language?: string
  /** Only for kind `external`: where the symbol comes from. */
  external?: { manager: string; package: string; version: string }
  /** Analyzer-native identifiers, kept so later steps can go back to raw evidence. */
  evidence: { analyzer: string; symbol: string }[]
}

export type EdgeKind = 'contains' | 'imports' | 'calls' | 'references' | 'implements'

export type EdgeRole =
  /** imports: file → file for a module specifier. */
  | 'module'
  /** imports: file → symbol for one imported or re-exported name. */
  | 'binding'
  /** imports: `export … from` in a barrel. */
  | 're-export'
  /** imports: `require('x')` or `import('x')`. */
  | 'dynamic'
  /** calls: `new X()`. */
  | 'new'
  /** references: a function passed as an argument at a call site. */
  | 'callback-argument'

export type Resolution =
  /** Target is a node defined in this repository. */
  | 'resolved'
  /** Target resolved to a symbol outside the repository (TypeScript lib, an installed package). */
  | 'external'
  /** Target is a function-local binding that is not modelled as a node. */
  | 'local'
  /** No target could be determined. `target.reason` says why. */
  | 'unresolved'

export type Provenance = 'scip' | 'ts-ast'

export type GraphEdge = {
  id: string
  kind: EdgeKind
  role?: EdgeRole
  from: string
  /** Null when `resolution` is `unresolved`. */
  to: string | null
  resolution: Resolution
  provenance: Provenance[]
  /** Every source site that evidences this edge. */
  sites: SourceSpan[]
  /** What the source said, and why it did not resolve, when relevant. */
  target?: { text: string; reason?: string }
}

export type FileStatus = 'analyzed' | 'skipped' | 'rejected'

export type FileRecord = {
  path: string
  status: FileStatus
  language: string | null
  bytes: number
  /** Why the file was skipped or rejected. */
  reason?: string
}

export type Diagnostic = {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
  path?: string
}

export type Coverage = {
  /** TS/JS files in the snapshot (the files this analyzer could cover). */
  sourceFiles: number
  analyzedFiles: number
  skippedFiles: number
  rejectedEntries: number
  skippedByReason: Record<string, number>
  /** Files in languages no indexer handles yet, by language. */
  unsupportedLanguages: Record<string, number>
  /** Bare imports whose packages are not present (indexing never installs dependencies). */
  missingDependencies: string[]
  nodes: number
  edges: number
  edgesByKind: Partial<Record<EdgeKind, number>>
  edgesByResolution: Partial<Record<Resolution, number>>
}

export type AnalyzerInfo = { name: string; version: string; detail?: Record<string, string> }

export type SoftwareGraph = {
  schemaVersion: typeof GRAPH_SCHEMA_VERSION
  repository: { id: number; fullName: string }
  commit: { sha: string; ref: string }
  analyzers: AnalyzerInfo[]
  /** Hash of analyzer versions and settings; a cached graph is reused only on an exact match. */
  analyzerConfigKey: string
  positionEncoding: 'utf-16'
  generatedAt: string
  status: 'complete' | 'partial'
  files: FileRecord[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  coverage: Coverage
  diagnostics: Diagnostic[]
}

export type IndexStage =
  'validating' | 'resolving' | 'downloading' | 'extracting' | 'indexing' | 'analyzing' | 'saving'

export type IndexedSnapshot = {
  sha: string
  ref: string
  state: 'complete' | 'partial'
  completedAt: string
  coverage: Coverage
  /** True when the last start reused an existing graph instead of re-indexing. */
  cached: boolean
}

export type IndexStatus = {
  repoId: number
  fullName: string
  state: 'idle' | 'running' | 'complete' | 'partial' | 'failed'
  stage?: IndexStage
  /** Commit of the attempt that is running or just failed, once known. */
  attemptSha?: string
  error?: string
  /** The last published graph. Survives failed refreshes and app restarts. */
  lastIndexed: IndexedSnapshot | null
}

export const indexingChannels = {
  start: 'indexing:start',
  retry: 'indexing:retry',
  getStatus: 'indexing:get-status',
  getGraph: 'indexing:get-graph',
  status: 'indexing:status'
} as const

/** Renderer-facing indexing operations. Repo IDs are checked against the GitHub session in main. */
export interface IndexingApi {
  /** Index the default branch, reusing a cached graph for the same commit and analyzers. */
  start(repoId: number): Promise<IndexStatus>
  /** Index again even if a cached graph matches. */
  retry(repoId: number): Promise<IndexStatus>
  getStatus(repoId: number): Promise<IndexStatus>
  /** The last published graph, or null if the repo was never indexed. */
  getGraph(repoId: number): Promise<SoftwareGraph | null>
  /** Status pushes for running jobs. Returns an unsubscribe function. */
  onStatus(listener: (status: IndexStatus) => void): () => void
}
