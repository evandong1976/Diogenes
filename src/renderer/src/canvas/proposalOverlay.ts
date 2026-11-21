/**
 * A design proposal drawn on the app canvas, without applying it. Pure, so it is tested directly
 * (test/canvas/proposalOverlay.test.ts).
 *
 * The app canvas shows Gemini's whiteboard boxes; the design draft is the indexed catalog. A
 * catalog component belongs to the box whose files hold most of its sources. Pending additions
 * become new boxes, removals mark the box (or a chip for the component), and connections are
 * drawn between whatever stands for their ends. Components with no box get an "indexed" chip, so
 * every changed connection has two visible ends.
 */
import type {
  CatalogEdge,
  CatalogGraph,
  CatalogKind,
  CatalogNode,
  CatalogOperation
} from '../../../shared/catalog'
import type { DraftState, ProjectState, Proposal } from '../../../shared/design'
import type { AppFlow, FlowBox, FlowKind } from '../../../shared/gemini'

/** The proposal the canvas shows, and the exact graph it was checked against. */
export type CanvasProposal =
  | {
      status: 'pending' | 'approved'
      proposal: Proposal
      /** The graph the patch applies to: the draft now (pending) or the intent's base (approved). */
      base: CatalogGraph
    }
  /** Checked against another draft revision or commit; nothing is drawn for it. */
  | { status: 'stale'; proposal: Proposal; draftRevision: number }

/**
 * The newest pending or approved proposal of the open thread. A pending one is drawn only while
 * the draft is still at its base revision and commit; an approved one only until the draft moves
 * past it. Discarding, revising or approving something else therefore removes the preview.
 */
export function focusedProposal(
  project: Pick<ProjectState, 'proposals' | 'intents'> | null,
  draft: DraftState | null,
  threadId: string | null
): CanvasProposal | null {
  if (!project || !draft || !threadId) return null
  const latest = project.proposals
    .filter((p) => p.threadId === threadId && (p.status === 'pending' || p.status === 'approved'))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1)
  if (!latest) return null
  const sameCommit =
    latest.patch.commitSha === draft.commitSha && latest.patch.repositoryId === draft.repository.id
  if (latest.status === 'pending')
    return sameCommit && latest.patch.baseRevision === draft.revision
      ? { status: 'pending', proposal: latest, base: draft.graph }
      : { status: 'stale', proposal: latest, draftRevision: draft.revision }
  const base = project.intents.find((i) => i.proposalId === latest.id)?.baseGraph
  if (!base || !sameCommit || draft.revision !== latest.preview.resultRevision) return null
  return { status: 'approved', proposal: latest, base }
}

export type OverlayChange = 'added' | 'removed' | 'updated' | 'indexed'

export type OverlayBox = FlowBox & { change: OverlayChange; componentId: string }

export interface OverlayLink {
  id: string
  from: string
  to: string
  label: string
  change: 'added' | 'removed'
}

export interface Overlay {
  proposalId: string
  status: 'pending' | 'approved'
  commitSha: string
  baseRevision: number
  resultRevision: number
  /** Boxes the canvas does not have: pending additions, removed or indexed components. */
  boxes: OverlayBox[]
  /** Existing whiteboard boxes the proposal removes or changes, by box ID. */
  boxMarks: Record<string, 'removed' | 'updated'>
  /** Connections to draw. */
  links: OverlayLink[]
  /** Existing whiteboard arrows the proposal removes, by link ID. */
  linkMarks: Record<string, 'removed'>
  /** Changed connections between components inside one box: listed, not drawn. */
  internal: number
}

const FLOW_KIND: Record<CatalogKind, FlowKind> = {
  view: 'screen',
  resource: 'data',
  dataContract: 'data',
  operation: 'service',
  module: 'service',
  workload: 'logic',
  stateMachine: 'logic',
  trigger: 'logic',
  workflow: 'logic',
  generic: 'logic'
}

/** Modules are packages; prefer the component that does something when picking a box's primary. */
const rank = (n: CatalogNode): number => (n.kind === 'module' || n.kind === 'dataContract' ? 1 : 0)

/** Indexed components whose sources sit in the box's files, primary first. */
export function componentsInBox(box: Pick<FlowBox, 'paths'>, graph: CatalogGraph): CatalogNode[] {
  if (!box.paths.length) return []
  const files = new Set(box.paths)
  const hits = (n: CatalogNode): number => n.sources.filter((s) => files.has(s.path)).length
  return graph.nodes
    .filter((n) => n.kind !== 'dataContract' && hits(n) > 0)
    .sort((a, b) => rank(a) - rank(b) || hits(b) - hits(a) || a.name.localeCompare(b.name))
}

/** The box that holds most of a component's sources. */
function boxOf(flow: AppFlow, node: CatalogNode): FlowBox | null {
  let best: FlowBox | null = null
  let bestHits = 0
  for (const box of flow.boxes) {
    const files = new Set(box.paths)
    const hits = node.sources.filter((s) => files.has(s.path)).length
    if (hits > bestHits) {
      best = box
      bestHits = hits
    }
  }
  return best
}

function patchNodes(ops: CatalogOperation[]): Map<string, CatalogNode> {
  const nodes = new Map<string, CatalogNode>()
  for (const op of ops) if ('node' in op) nodes.set(op.node.id, op.node)
  return nodes
}

function patchEdges(ops: CatalogOperation[]): Map<string, CatalogEdge> {
  const edges = new Map<string, CatalogEdge>()
  for (const op of ops) {
    if (op.type === 'connect' || op.type === 'rewire') edges.set(op.edge.id, op.edge)
    if (op.type === 'insert') {
      edges.set(op.incoming.id, op.incoming)
      edges.set(op.outgoing.id, op.outgoing)
    }
  }
  return edges
}

const describe = (n: CatalogNode): string => `${n.kind} · ${n.id}`

export function proposalOverlay(
  flow: AppFlow,
  focus: Extract<CanvasProposal, { proposal: Proposal; base: CatalogGraph }>
): Overlay {
  const { proposal, base } = focus
  const { preview, patch } = proposal
  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]))
  const baseEdges = new Map(base.edges.map((e) => [e.id, e]))
  const opNodes = patchNodes(patch.operations)
  const opEdges = patchEdges(patch.operations)
  const change = new Map(preview.components.map((c) => [c.id, c.change]))

  const boxes = new Map<string, OverlayBox>()
  const boxMarks: Overlay['boxMarks'] = {}
  const chip = (id: string, node: CatalogNode, kind: OverlayChange): string => {
    if (!boxes.has(id))
      boxes.set(id, {
        id,
        kind: FLOW_KIND[node.kind] ?? 'logic',
        name: node.name,
        summary: describe(node),
        tables: [],
        paths: [...new Set(node.sources.map((s) => s.path))],
        change: kind,
        componentId: node.id
      })
    return id
  }

  /** The canvas node standing for a catalog component, created on first use. */
  const endpoint = (componentId: string): string | null => {
    const was = change.get(componentId)
    if (was === 'added') {
      const node = opNodes.get(componentId)
      return node ? chip(`pending:${componentId}`, node, 'added') : null
    }
    const node = baseNodes.get(componentId)
    if (!node) return null
    const box = boxOf(flow, node)
    if (was === 'removed') {
      if (box && componentsInBox(box, base)[0]?.id === componentId) {
        boxMarks[box.id] = 'removed'
        return box.id
      }
      return chip(`removed:${componentId}`, node, 'removed')
    }
    if (box) {
      if (was === 'updated') boxMarks[box.id] ??= 'updated'
      return box.id
    }
    return chip(`indexed:${componentId}`, node, was === 'updated' ? 'updated' : 'indexed')
  }

  // Every changed component is visible even when no changed connection reaches it. Data
  // contracts are port annotations, not things on the whiteboard.
  for (const c of preview.components)
    if ((opNodes.get(c.id) ?? baseNodes.get(c.id))?.kind !== 'dataContract') endpoint(c.id)

  const links: OverlayLink[] = []
  const linkMarks: Overlay['linkMarks'] = {}
  let internal = 0
  const rewired = new Set(
    preview.connections
      .filter((c) => c.change === 'removed')
      .map((c) => c.id)
      .filter((id) => preview.connections.some((c) => c.id === id && c.change === 'added'))
  )
  for (const c of preview.connections) {
    const edge = c.change === 'removed' ? baseEdges.get(c.id) : opEdges.get(c.id)
    if (!edge || edge.kind === 'contains') continue
    const from = endpoint(edge.from.nodeId)
    const to = endpoint(edge.to.nodeId)
    if (!from || !to) continue
    if (from === to) {
      internal++
      continue
    }
    const label = `${rewired.has(c.id) ? 'rewire · ' : ''}${edge.kind.replace('_', ' ')}`
    if (c.change === 'removed') {
      const drawn = flow.links.find(
        (l) => (l.from === from && l.to === to) || (l.from === to && l.to === from)
      )
      if (drawn) {
        linkMarks[drawn.id] = 'removed'
        continue
      }
    }
    links.push({ id: `${c.change}:${c.id}`, from, to, label, change: c.change })
  }

  return {
    proposalId: proposal.id,
    status: focus.status,
    commitSha: patch.commitSha,
    baseRevision: preview.baseRevision,
    resultRevision: preview.resultRevision,
    boxes: [...boxes.values()],
    boxMarks,
    links,
    linkMarks,
    internal
  }
}
