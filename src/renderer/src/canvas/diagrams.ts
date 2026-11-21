import type { ArchitectureGraph, CurrentGraph, ProposedEdit } from '../../../shared/gemini'

export type Change = 'unchanged' | 'added' | 'removed'

export interface DiagramSource {
  path: string
  startLine?: number
  endLine?: number
}

// A type alias, not an interface, so React Flow accepts it as node data.
export type DiagramNode = {
  id: string
  /** Header text, such as STATE or DATABASE. */
  kind: string
  label: string
  /** One line of metadata under the name. */
  meta: string
  detail?: string
  tag?: string
  change: Change
  sources: DiagramSource[]
}

export interface DiagramEdge {
  id: string
  from: string
  to: string
  label: string
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

const refs = (sources: DiagramSource[]): string =>
  sources.length
    ? `${sources.length} source ref${sources.length === 1 ? '' : 's'}`
    : 'Not in code yet'

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
      detail: t.trigger,
      change: (preview?.replaceTransitionId === t.id ? 'removed' : 'unchanged') as Change,
      sources: t.sources
    })),
    ...(preview?.addTransitions ?? []).map((t) => ({
      id: t.id,
      from: t.from,
      to: t.to,
      label: t.trigger,
      detail: t.trigger,
      change: 'added' as Change,
      sources: []
    }))
  ]
  return { roots: [graph.initialStateId], nodes, edges }
}

export function architectureDiagram(graph: ArchitectureGraph): Diagram {
  const targets = new Set(graph.connections.map((c) => c.to))
  const roots = graph.components.filter((c) => !targets.has(c.id)).map((c) => c.id)
  return {
    roots: roots.length ? roots : graph.components.slice(0, 1).map((c) => c.id),
    nodes: graph.components.map((c) => ({
      id: c.id,
      kind: c.type.replace('-', ' '),
      label: c.label,
      meta: c.paths[0] ?? 'Inferred',
      detail: c.detail,
      change: 'unchanged',
      sources: c.paths.map((path) => ({ path }))
    })),
    edges: graph.connections.map((c) => ({
      id: c.id,
      from: c.from,
      to: c.to,
      label: c.label,
      change: 'unchanged',
      sources: []
    }))
  }
}
