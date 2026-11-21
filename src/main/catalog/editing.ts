import type {
  CatalogEdge,
  CatalogEdgeKind,
  CatalogEndpoint,
  CatalogGraph,
  CatalogIssueCode,
  CatalogKind,
  CatalogNode,
  CatalogOperation,
  CatalogPatch,
  CatalogPatchResult,
  CatalogPort,
  CatalogProtocol
} from '../../shared/catalog'

const KINDS: readonly CatalogKind[] = [
  'module',
  'workload',
  'operation',
  'resource',
  'dataContract',
  'stateMachine',
  'view',
  'trigger',
  'workflow',
  'generic'
]
const EDGE_KINDS: readonly CatalogEdgeKind[] = [
  'contains',
  'depends_on',
  'calls',
  'publishes_to',
  'subscribes_to',
  'reads',
  'writes',
  'triggers',
  'flows_to',
  'navigates_to'
]
const PROTOCOLS: readonly CatalogProtocol[] = [
  'local',
  'electron-ipc',
  'http',
  'rpc',
  'cli',
  'event',
  'data',
  'schedule',
  'navigation',
  'state'
]
const RESOLUTIONS: readonly CatalogNode['resolution'][] = [
  'bound',
  'declared',
  'unresolved',
  'proposed'
]

class PatchError extends Error {
  constructor(
    readonly code: CatalogIssueCode,
    message: string,
    readonly entityId?: string
  ) {
    super(message)
  }
}

function fail(code: CatalogIssueCode, message: string, entityId?: string): never {
  throw new PatchError(code, message, entityId)
}

/**
 * Apply an ordered, atomic patch to a copy of the graph. The input graph is never mutated.
 * Observed edges keep whatever evidence they have; only edges created by this patch must
 * resolve to compatible ports.
 */
export function applyCatalogPatch(graph: CatalogGraph, patch: CatalogPatch): CatalogPatchResult {
  if (patch.repositoryId !== graph.repository.id || patch.commitSha !== graph.commit.sha) {
    return issue(
      'stale',
      `Patch targets ${patch.repositoryId}@${patch.commitSha}, draft is ${graph.repository.id}@${graph.commit.sha}`
    )
  }
  if (patch.baseRevision !== graph.revision) {
    return issue(
      'stale',
      `Patch base revision ${patch.baseRevision} does not match draft revision ${graph.revision}`
    )
  }
  const draft = structuredClone(graph)
  for (const [index, operation] of patch.operations.entries()) {
    try {
      apply(draft, operation)
    } catch (error) {
      if (!(error instanceof PatchError)) throw error
      return issue(error.code, error.message, index, error.entityId)
    }
  }
  draft.revision = graph.revision + 1
  return { ok: true, graph: draft }
}

function issue(
  code: CatalogIssueCode,
  message: string,
  operationIndex?: number,
  entityId?: string
): CatalogPatchResult {
  return { ok: false, issue: { code, message, operationIndex, entityId } }
}

function apply(draft: CatalogGraph, op: CatalogOperation): void {
  switch (op.type) {
    case 'create':
      if (findNode(draft, op.node.id))
        fail('duplicate', `Node ${op.node.id} already exists`, op.node.id)
      checkNode(draft, op.node)
      draft.nodes.push(structuredClone(op.node))
      return
    case 'update': {
      const index = draft.nodes.findIndex((n) => n.id === op.node.id)
      if (index < 0) fail('missing', `Node ${op.node.id} does not exist`, op.node.id)
      checkNode(draft, op.node)
      const dependents = draft.edges.filter(
        (e) => e.from.nodeId === op.node.id || e.to.nodeId === op.node.id
      )
      const wereCompatible = dependents.filter(
        (e) => e.kind !== 'contains' && portsCompatible(draft, e)
      )
      draft.nodes[index] = structuredClone(op.node)
      checkDependentEdges(draft, op.node.id, dependents, wereCompatible)
      return
    }
    case 'connect':
      connect(draft, op.edge)
      return
    case 'disconnect':
      removeEdge(draft, op.edgeId)
      return
    case 'rewire':
      removeEdge(draft, op.edge.id)
      connect(draft, op.edge)
      return
    case 'insert': {
      const old = removeEdge(draft, op.edgeId)
      if (old.kind === 'contains')
        fail('unsupported', 'Cannot insert a node into a containment edge', old.id)
      if (!sameEndpoint(op.incoming.from, old.from) || op.incoming.to.nodeId !== op.node.id) {
        fail(
          'invalid-edge',
          `Incoming edge must run from ${describe(old.from)} to ${op.node.id}`,
          op.incoming.id
        )
      }
      if (op.outgoing.from.nodeId !== op.node.id || !sameEndpoint(op.outgoing.to, old.to)) {
        fail(
          'invalid-edge',
          `Outgoing edge must run from ${op.node.id} to ${describe(old.to)}`,
          op.outgoing.id
        )
      }
      apply(draft, { type: 'create', node: op.node })
      connect(draft, op.incoming)
      connect(draft, op.outgoing)
      return
    }
    case 'delete': {
      if (!findNode(draft, op.nodeId))
        fail('missing', `Node ${op.nodeId} does not exist`, op.nodeId)
      const attached = draft.edges.find(
        (e) => e.from.nodeId === op.nodeId || e.to.nodeId === op.nodeId
      )
      if (attached) {
        fail(
          'dangling',
          `Deleting ${op.nodeId} would leave edge ${attached.id} dangling; disconnect it first`,
          attached.id
        )
      }
      draft.nodes = draft.nodes.filter((n) => n.id !== op.nodeId)
      return
    }
    default:
      fail('unsupported', `Unsupported operation ${(op as { type?: unknown }).type}`)
  }
}

function checkNode(draft: CatalogGraph, node: CatalogNode): void {
  if (!node.id || typeof node.name !== 'string')
    fail('invalid-node', 'Node needs an id and a name', node.id)
  if (!KINDS.includes(node.kind)) fail('invalid-node', `Unknown node kind ${node.kind}`, node.id)
  if (!RESOLUTIONS.includes(node.resolution))
    fail('invalid-node', `Unknown resolution ${node.resolution}`, node.id)
  const seen = new Set<string>()
  for (const port of node.ports) {
    const at = `${node.id}.${port.id}`
    if (!port.id || seen.has(port.id))
      fail('duplicate', `Port ${at} is missing or duplicated`, node.id)
    seen.add(port.id)
    if (port.direction !== 'in' && port.direction !== 'out')
      fail('invalid-port', `Port ${at} has an invalid direction`, node.id)
    if (!PROTOCOLS.includes(port.protocol))
      fail('invalid-port', `Port ${at} has unknown protocol ${port.protocol}`, node.id)
    if (
      port.maxConnections !== undefined &&
      !(Number.isInteger(port.maxConnections) && port.maxConnections > 0)
    ) {
      fail('invalid-port', `Port ${at} maxConnections must be a positive integer`, node.id)
    }
    if (
      port.contractId !== undefined &&
      findNode(draft, port.contractId)?.kind !== 'dataContract'
    ) {
      fail(
        'invalid-port',
        `Port ${at} references unknown data contract ${port.contractId}`,
        node.id
      )
    }
  }
}

/**
 * After an update, edges that named a port on this node must still find it, and edges that
 * were compatible must stay compatible. Already-incomplete observed edges stay as they are.
 */
function checkDependentEdges(
  draft: CatalogGraph,
  nodeId: string,
  dependents: CatalogEdge[],
  wereCompatible: CatalogEdge[]
): void {
  for (const edge of dependents) {
    for (const end of [edge.from, edge.to]) {
      if (end.nodeId === nodeId && end.portId !== undefined && !findPort(draft, end)) {
        fail(
          'dangling',
          `Edge ${edge.id} uses removed port ${describe(end)}; disconnect or rewire it`,
          edge.id
        )
      }
    }
  }
  for (const edge of wereCompatible) checkPorts(draft, edge)
}

function portsCompatible(draft: CatalogGraph, edge: CatalogEdge): boolean {
  try {
    checkPorts(draft, edge)
    return true
  } catch (error) {
    if (error instanceof PatchError) return false
    throw error
  }
}

function connect(draft: CatalogGraph, edge: CatalogEdge): void {
  if (!edge.id) fail('invalid-edge', 'Edge needs an id')
  if (draft.edges.some((e) => e.id === edge.id))
    fail('duplicate', `Edge ${edge.id} already exists`, edge.id)
  if (!EDGE_KINDS.includes(edge.kind))
    fail('invalid-edge', `Unknown edge kind ${edge.kind}`, edge.id)
  for (const end of [edge.from, edge.to]) {
    if (!findNode(draft, end.nodeId))
      fail('missing', `Edge ${edge.id} endpoint ${end.nodeId} does not exist`, edge.id)
  }
  if (edge.kind === 'contains') checkContainment(draft, edge)
  else checkPorts(draft, edge)
  draft.edges.push(structuredClone(edge))
}

function checkContainment(draft: CatalogGraph, edge: CatalogEdge): void {
  const parent = edge.from.nodeId
  const child = edge.to.nodeId
  if (draft.edges.some((e) => e.kind === 'contains' && e.to.nodeId === child)) {
    fail('invalid-edge', `${child} already has a containing parent`, edge.id)
  }
  // Adding parent -> child closes a cycle when child already (transitively) contains parent.
  const stack = [child]
  const visited = new Set<string>()
  while (stack.length) {
    const current = stack.pop()!
    if (current === parent)
      fail('invalid-edge', `Containing ${child} in ${parent} creates a cycle`, edge.id)
    if (visited.has(current)) continue
    visited.add(current)
    for (const e of draft.edges)
      if (e.kind === 'contains' && e.from.nodeId === current) stack.push(e.to.nodeId)
  }
}

function checkPorts(draft: CatalogGraph, edge: CatalogEdge): void {
  const from = findPort(draft, edge.from)
  const to = findPort(draft, edge.to)
  if (!from)
    fail(
      'invalid-port',
      `Edge ${edge.id} source port ${describe(edge.from)} does not resolve`,
      edge.id
    )
  if (!to)
    fail(
      'invalid-port',
      `Edge ${edge.id} target port ${describe(edge.to)} does not resolve`,
      edge.id
    )
  if (from.direction !== 'out')
    fail('invalid-port', `Source port ${describe(edge.from)} is not an out port`, edge.id)
  if (to.direction !== 'in')
    fail('invalid-port', `Target port ${describe(edge.to)} is not an in port`, edge.id)
  if (from.protocol !== to.protocol) {
    fail(
      'incompatible',
      `Protocol ${from.protocol} at ${describe(edge.from)} does not match ${to.protocol} at ${describe(edge.to)}`,
      edge.id
    )
  }
  if (from.contractId === undefined || to.contractId === undefined) {
    fail(
      'incompatible',
      `Edge ${edge.id} has an unresolved data contract; establish both port contracts first`,
      edge.id
    )
  }
  if (from.contractId !== to.contractId) {
    fail('incompatible', `Contract ${from.contractId} does not match ${to.contractId}`, edge.id)
  }
  for (const [end, port] of [
    [edge.from, from],
    [edge.to, to]
  ] as const) {
    if (port.maxConnections === undefined) continue
    const used = draft.edges.filter(
      (e) => e.id !== edge.id && (sameEndpoint(e.from, end) || sameEndpoint(e.to, end))
    ).length
    if (used + 1 > port.maxConnections) {
      fail(
        'incompatible',
        `Port ${describe(end)} allows ${port.maxConnections} connection(s)`,
        edge.id
      )
    }
  }
}

function removeEdge(draft: CatalogGraph, edgeId: string): CatalogEdge {
  const index = draft.edges.findIndex((e) => e.id === edgeId)
  if (index < 0) fail('missing', `Edge ${edgeId} does not exist`, edgeId)
  return draft.edges.splice(index, 1)[0]
}

const findNode = (draft: CatalogGraph, id: string): CatalogNode | undefined =>
  draft.nodes.find((n) => n.id === id)

const findPort = (draft: CatalogGraph, end: CatalogEndpoint): CatalogPort | undefined =>
  end.portId === undefined
    ? undefined
    : findNode(draft, end.nodeId)?.ports.find((p) => p.id === end.portId)

const sameEndpoint = (a: CatalogEndpoint, b: CatalogEndpoint): boolean =>
  a.nodeId === b.nodeId && a.portId === b.portId

const describe = (end: CatalogEndpoint): string =>
  end.portId ? `${end.nodeId}.${end.portId}` : end.nodeId
