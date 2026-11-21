import type {
  CatalogEdgeKind,
  CatalogGraph,
  CatalogKind,
  CatalogNode,
  CatalogProtocol
} from '../../../shared/catalog'
import type {
  ArchitectureGraph,
  CurrentGraph,
  ProposedEdit,
  SourceReference
} from '../../../shared/gemini'

export type Change = 'unchanged' | 'added' | 'removed'

/** Design system v0.2 port and edge colors. */
export type PortType = 'http' | 'data' | 'auth' | 'event'

export interface DiagramSource {
  path: string
  startLine?: number
  endLine?: number
}

// A type alias, not an interface, so React Flow accepts it as node data.
export type DiagramNode = {
  id: string
  /** Small label above the name, such as STATE or WORKLOAD. */
  kind: string
  label: string
  /** One line of metadata in the header, such as a source count. */
  meta: string
  detail?: string
  tag?: string
  change: Change
  /** Draws the node with the design system's error state, for unresolved evidence. */
  unresolved?: boolean
  sources: DiagramSource[]
}

export interface DiagramEdge {
  id: string
  from: string
  to: string
  label: string
  type: PortType
  detail?: string
  change: Change
  sources: DiagramSource[]
}

export interface Diagram {
  /** Nodes laid out in the first column. */
  roots: string[]
  nodes: DiagramNode[]
  edges: DiagramEdge[]
}

const refs = (sources: unknown[]): string =>
  sources.length
    ? `${sources.length} source ref${sources.length === 1 ? '' : 's'}`
    : 'Not in code yet'

/** Nodes with no incoming edge start the layout; fall back to the first node for cycles. */
function rootsOf(nodes: { id: string }[], edges: { to: string }[]): string[] {
  const targets = new Set(edges.map((e) => e.to))
  const roots = nodes.filter((n) => !targets.has(n.id)).map((n) => n.id)
  return roots.length ? roots : nodes.slice(0, 1).map((n) => n.id)
}

// ---- Code logic ----

/** A state graph, optionally with a proposed edit overlaid (not applied). */
export function stateDiagram(graph: CurrentGraph, preview?: ProposedEdit | null): Diagram {
  const nodes: DiagramNode[] = [
    ...graph.states.map((s) => ({
      id: s.id,
      kind: 'State',
      label: s.label,
      meta: refs(s.sources),
      tag: s.id === graph.initialStateId ? 'Start' : undefined,
      change: 'unchanged' as Change,
      sources: s.sources
    })),
    ...(preview?.addStates ?? []).map((s) => ({
      id: s.id,
      kind: 'State',
      label: s.label,
      meta: refs([]),
      change: 'added' as Change,
      sources: []
    }))
  ]
  const edges: DiagramEdge[] = [
    ...graph.transitions.map((t) => ({
      id: t.id,
      from: t.from,
      to: t.to,
      label: t.trigger,
      type: 'event' as PortType,
      detail: t.trigger,
      change: (preview?.replaceTransitionId === t.id ? 'removed' : 'unchanged') as Change,
      sources: t.sources
    })),
    ...(preview?.addTransitions ?? []).map((t) => ({
      id: t.id,
      from: t.from,
      to: t.to,
      label: t.trigger,
      type: 'event' as PortType,
      detail: t.trigger,
      change: 'added' as Change,
      sources: []
    }))
  ]
  return { roots: [graph.initialStateId], nodes, edges }
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'state'

/** Catalog state machines with enough structure to draw. */
export function catalogStateMachines(
  catalog: CatalogGraph | null | undefined
): Extract<CatalogNode, { kind: 'stateMachine' }>[] {
  return (catalog?.nodes ?? []).filter(
    (n): n is Extract<CatalogNode, { kind: 'stateMachine' }> =>
      n.kind === 'stateMachine' && (n.properties.states?.length ?? 0) >= 2
  )
}

/**
 * Turns an indexed state machine into the canvas state graph. Parallel transitions between the
 * same states are merged, since transition IDs are `from->to`. The machine's own source binding
 * goes on its initial state.
 */
export function stateGraphFromCatalog(
  machine: Extract<CatalogNode, { kind: 'stateMachine' }>
): CurrentGraph {
  const states = machine.properties.states ?? []
  const ids = new Map(states.map((s) => [s, slug(s)]))
  const initial = machine.properties.initialState ?? states[0]
  const sources: SourceReference[] = machine.sources
    .filter((s) => s.span)
    .map((s) => ({
      path: s.path,
      startLine: s.span!.start.line + 1,
      endLine: s.span!.end.line + 1
    }))
  const merged = new Map<string, { from: string; to: string; events: string[] }>()
  for (const t of machine.properties.transitions ?? []) {
    const from = ids.get(t.from)
    const to = ids.get(t.to)
    if (!from || !to) continue
    const id = `${from}->${to}`
    const entry = merged.get(id) ?? { from, to, events: [] }
    entry.events.push(t.guard ? `${t.event} [${t.guard}]` : t.event)
    merged.set(id, entry)
  }
  return {
    initialStateId: ids.get(initial) ?? slug(initial),
    states: states.map((s) => ({
      id: ids.get(s)!,
      label: s,
      sources: s === initial ? sources : []
    })),
    transitions: [...merged].map(([id, t]) => ({
      id,
      from: t.from,
      to: t.to,
      trigger: t.events.join(' / '),
      sources: []
    }))
  }
}

// ---- Architecture levels ----

/** Catalog kinds per level, matching RepositoryCatalog's list view. */
export const catalogKindsByLevel: Record<'infrastructure' | 'integrations', CatalogKind[]> = {
  infrastructure: ['module', 'workload', 'resource'],
  integrations: ['operation', 'view', 'trigger', 'workflow']
}

const KIND_LABELS: Record<CatalogKind, string> = {
  module: 'Module',
  workload: 'Workload',
  operation: 'Operation',
  resource: 'Resource',
  dataContract: 'Data contract',
  stateMachine: 'State machine',
  view: 'View',
  trigger: 'Trigger',
  workflow: 'Workflow',
  generic: 'Component'
}

const PROTOCOL_PORT: Record<CatalogProtocol, PortType> = {
  http: 'http',
  rpc: 'http',
  'electron-ipc': 'http',
  cli: 'http',
  navigation: 'http',
  local: 'data',
  data: 'data',
  state: 'data',
  event: 'event',
  schedule: 'event'
}

const EDGE_PORT: Record<CatalogEdgeKind, PortType> = {
  contains: 'data',
  depends_on: 'data',
  calls: 'http',
  publishes_to: 'event',
  subscribes_to: 'event',
  reads: 'data',
  writes: 'data',
  triggers: 'event',
  flows_to: 'data',
  navigates_to: 'http'
}

/** The one-line summary of a node's typed properties. */
function describe(node: CatalogNode): string | undefined {
  switch (node.kind) {
    case 'module':
      return [node.properties.packageName, node.properties.root].filter(Boolean).join(' · ')
    case 'workload':
      return [node.properties.role, node.properties.entryPoint].filter(Boolean).join(' · ')
    case 'operation':
      return [node.properties.protocol, node.properties.address].filter(Boolean).join(' ')
    case 'resource':
      return [node.properties.resourceType, node.properties.address].filter(Boolean).join(' · ')
    case 'view':
      return node.properties.route
    case 'trigger':
      return node.properties.schedule ?? node.properties.event
    case 'workflow':
      return node.properties.steps?.join(' → ')
    default:
      return undefined
  }
}

const MAX_CATALOG_NODES = 60

/**
 * Draws the catalog nodes for a level, keeping the most connected ones when there are many.
 * `contains` edges are left out: they nest, they don't connect.
 */
export function catalogDiagram(catalog: CatalogGraph, kinds: CatalogKind[]): Diagram {
  const candidates = catalog.nodes.filter((n) => kinds.includes(n.kind))
  const ids = new Set(candidates.map((n) => n.id))
  const links = catalog.edges.filter(
    (e) => e.kind !== 'contains' && ids.has(e.from.nodeId) && ids.has(e.to.nodeId)
  )
  const degree = new Map<string, number>()
  for (const e of links) {
    degree.set(e.from.nodeId, (degree.get(e.from.nodeId) ?? 0) + 1)
    degree.set(e.to.nodeId, (degree.get(e.to.nodeId) ?? 0) + 1)
  }
  const shown = [...candidates]
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, MAX_CATALOG_NODES)
  const shownIds = new Set(shown.map((n) => n.id))
  const portOf = new Map(
    catalog.nodes.flatMap((n) => n.ports.map((p) => [`${n.id}\0${p.id}`, p.protocol] as const))
  )

  const nodes: DiagramNode[] = shown.map((n) => ({
    id: n.id,
    kind: KIND_LABELS[n.kind],
    label: n.name,
    meta: refs(n.sources),
    detail: describe(n) || undefined,
    tag: n.resolution === 'declared' ? 'Declared' : undefined,
    change: n.resolution === 'proposed' ? 'added' : 'unchanged',
    unresolved: n.resolution === 'unresolved',
    sources: n.sources.map((s) => ({
      path: s.path,
      startLine: s.span ? s.span.start.line + 1 : undefined,
      endLine: s.span ? s.span.end.line + 1 : undefined
    }))
  }))
  const edges: DiagramEdge[] = links
    .filter((e) => shownIds.has(e.from.nodeId) && shownIds.has(e.to.nodeId))
    .map((e) => {
      const protocol = e.from.portId ? portOf.get(`${e.from.nodeId}\0${e.from.portId}`) : undefined
      return {
        id: e.id,
        from: e.from.nodeId,
        to: e.to.nodeId,
        label: e.kind.replace('_', ' '),
        type: protocol ? PROTOCOL_PORT[protocol] : EDGE_PORT[e.kind],
        change: 'unchanged',
        sources: e.sources.map((s) => ({
          path: s.path,
          startLine: s.span ? s.span.start.line + 1 : undefined,
          endLine: s.span ? s.span.end.line + 1 : undefined
        }))
      }
    })
  return { roots: rootsOf(nodes, edges), nodes, edges }
}

/** Gemini's file-list architecture, used when the repo has no indexed catalog. */
export function architectureDiagram(graph: ArchitectureGraph): Diagram {
  const nodes: DiagramNode[] = graph.components.map((c) => ({
    id: c.id,
    kind: c.type.replace('-', ' '),
    label: c.label,
    meta: c.paths[0] ?? 'Inferred',
    detail: c.detail,
    change: 'unchanged',
    sources: c.paths.map((path) => ({ path }))
  }))
  const edges: DiagramEdge[] = graph.connections.map((c) => ({
    id: c.id,
    from: c.from,
    to: c.to,
    label: c.label,
    type: /http|rest|api|rpc/i.test(c.label)
      ? 'http'
      : /auth|oauth|jwt/i.test(c.label)
        ? 'auth'
        : /event|queue|pub|sub/i.test(c.label)
          ? 'event'
          : 'data',
    change: 'unchanged',
    sources: []
  }))
  return { roots: rootsOf(nodes, edges), nodes, edges }
}
