import type { SourceSpan } from './indexing'

export const CATALOG_SCHEMA_VERSION = 1

export interface CatalogProperties {
  module: { ecosystem?: string; packageName?: string; root?: string }
  workload: { role?: 'service' | 'worker' | 'cli' | 'process' | 'job'; entryPoint?: string }
  operation: { protocol?: CatalogProtocol; address?: string; handlerId?: string }
  resource: { resourceType?: 'store' | 'queue' | 'topic' | 'bucket' | 'asset'; address?: string }
  dataContract: { format?: string; version?: string; symbolId?: string }
  stateMachine: {
    initialState?: string
    states?: string[]
    transitions?: CatalogTransition[]
    /** Canonical executable model when present. Older snapshots use only the descriptive fields. */
    behavior?: RetryBehavior
  }
  view: { route?: string }
  trigger: { schedule?: string; event?: string }
  workflow: { entryStep?: string; steps?: string[] }
  generic: { description?: string }
}

export type CatalogKind = keyof CatalogProperties

export interface CatalogTransition {
  from: string
  to: string
  event: string
  guard?: string
}

/** Attempt numbers in the shared retry event domain. */
export type RetryAttemptNumber = 1 | 2 | 3

export type RetryEvent =
  { type: 'Start' } | { type: 'Succeeded' | 'Failed'; attempt: RetryAttemptNumber }

export type RetryEffect = { type: 'NoEffect' } | { type: 'RunAttempt'; attempt: RetryAttemptNumber }

export interface RetryTransition {
  /** Stable across revisions so reviews and checks can name a row. */
  id: string
  from: string
  event: RetryEvent
  to: string
  effect: RetryEffect
}

/**
 * Versioned behavior of a retry state machine. Unlisted state/event pairs keep the state and
 * emit NoEffect, so the transitions plus this rule define the whole step function.
 */
export interface RetryBehavior {
  version: 1
  initialState: string
  states: string[]
  transitions: RetryTransition[]
}

export type CatalogProtocol =
  | 'local'
  | 'electron-ipc'
  | 'http'
  | 'rpc'
  | 'cli'
  | 'event'
  | 'data'
  | 'schedule'
  | 'navigation'
  | 'state'

export interface CatalogSource {
  path: string
  span?: SourceSpan
  evidenceId?: string
  field?: string
}

export interface CatalogPort {
  id: string
  direction: 'in' | 'out'
  protocol: CatalogProtocol
  /** Undefined when the contract could not be established. */
  contractId?: string
  maxConnections?: number
}

export type CatalogNode = {
  [K in CatalogKind]: {
    id: string
    kind: K
    name: string
    resolution: 'bound' | 'declared' | 'unresolved' | 'proposed'
    properties: CatalogProperties[K]
    ports: CatalogPort[]
    sources: CatalogSource[]
  }
}[CatalogKind]

export type CatalogEdgeKind =
  | 'contains'
  | 'depends_on'
  | 'calls'
  | 'publishes_to'
  | 'subscribes_to'
  | 'reads'
  | 'writes'
  | 'triggers'
  | 'flows_to'
  | 'navigates_to'

export interface CatalogEndpoint {
  nodeId: string
  portId?: string
}

export interface CatalogEdge {
  id: string
  kind: CatalogEdgeKind
  from: CatalogEndpoint
  to: CatalogEndpoint
  sources: CatalogSource[]
}

export interface CatalogGraph {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION
  repository: { id: number; fullName: string }
  commit: { sha: string; ref: string }
  /** Observed snapshots start at zero. Successful draft patches increment this value. */
  revision: number
  nodes: CatalogNode[]
  edges: CatalogEdge[]
}

export type CatalogOperation =
  | { type: 'create'; node: CatalogNode }
  | { type: 'update'; node: CatalogNode }
  | { type: 'connect'; edge: CatalogEdge }
  | { type: 'disconnect'; edgeId: string }
  | { type: 'rewire'; edge: CatalogEdge }
  | {
      type: 'insert'
      edgeId: string
      node: CatalogNode
      incoming: CatalogEdge
      outgoing: CatalogEdge
    }
  | { type: 'delete'; nodeId: string }

export interface CatalogPatch {
  repositoryId: number
  commitSha: string
  baseRevision: number
  operations: CatalogOperation[]
}

export type CatalogIssueCode =
  | 'stale'
  | 'duplicate'
  | 'missing'
  | 'dangling'
  | 'invalid-node'
  | 'invalid-edge'
  | 'invalid-port'
  | 'incompatible'
  | 'unsupported'

export type CatalogPatchResult =
  | { ok: true; graph: CatalogGraph }
  | {
      ok: false
      issue: { code: CatalogIssueCode; message: string; operationIndex?: number; entityId?: string }
    }

export const catalogChannels = { preview: 'catalog:preview' } as const

export interface CatalogApi {
  preview(patch: CatalogPatch): Promise<CatalogPatchResult>
}
