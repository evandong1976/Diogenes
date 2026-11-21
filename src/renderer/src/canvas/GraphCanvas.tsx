import { useMemo, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { CurrentGraph, ProposedEdit, SourceReference } from '../../../shared/gemini'
import { layeredLayout } from './layout'

type Change = 'unchanged' | 'added' | 'removed'

interface Item {
  kind: 'state' | 'transition'
  id: string
  title: string
  detail?: string
  change: Change
  sources: SourceReference[]
}

type StateNodeData = { label: string; initial: boolean; change: Change }
type StateNode = Node<StateNodeData, 'state'>

const COLORS: Record<Change, string> = {
  unchanged: 'var(--ev-c-gray-1)',
  added: '#3fb950',
  removed: '#f85149'
}

function StateNodeView({ data, selected }: NodeProps<StateNode>): React.JSX.Element {
  return (
    <div
      className="state-node"
      data-change={data.change}
      data-selected={selected || undefined}
      style={{ borderColor: COLORS[data.change] }}
    >
      <Handle type="target" position={Position.Left} />
      {data.initial && <span className="state-node-tag">start</span>}
      {data.label}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const nodeTypes = { state: StateNodeView }

function truncate(text: string, max = 34): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

interface Props {
  graph: CurrentGraph
  /** When set, the canvas overlays this edit on the graph instead of applying it. */
  preview?: ProposedEdit | null
}

export function GraphCanvas({ graph, preview }: Props): React.JSX.Element {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const { nodes, edges, items } = useMemo(() => {
    const items = new Map<string, Item>()
    for (const s of graph.states) {
      items.set(`state:${s.id}`, {
        kind: 'state',
        id: s.id,
        title: s.label,
        change: 'unchanged',
        sources: s.sources
      })
    }
    for (const t of graph.transitions) {
      items.set(`transition:${t.id}`, {
        kind: 'transition',
        id: t.id,
        title: `${t.from} → ${t.to}`,
        detail: t.trigger,
        change: preview?.replaceTransitionId === t.id ? 'removed' : 'unchanged',
        sources: t.sources
      })
    }
    for (const s of preview?.addStates ?? []) {
      items.set(`state:${s.id}`, {
        kind: 'state',
        id: s.id,
        title: s.label,
        change: 'added',
        sources: []
      })
    }
    for (const t of preview?.addTransitions ?? []) {
      items.set(`transition:${t.id}`, {
        kind: 'transition',
        id: t.id,
        title: `${t.from} → ${t.to}`,
        detail: t.trigger,
        change: 'added',
        sources: []
      })
    }

    const states = [...graph.states, ...(preview?.addStates ?? [])]
    const transitions = [...graph.transitions, ...(preview?.addTransitions ?? [])]
    // Lay out the graph as it will be after the edit, so added states get their own column.
    const live = transitions.filter((t) => t.id !== preview?.replaceTransitionId)
    const positions = layeredLayout(
      graph.initialStateId,
      states.map((s) => s.id),
      live
    )

    const nodes: StateNode[] = states.map((s) => ({
      id: s.id,
      type: 'state',
      position: positions.get(s.id)!,
      data: {
        label: s.label,
        initial: s.id === graph.initialStateId,
        change: items.get(`state:${s.id}`)!.change
      }
    }))

    const edges: Edge[] = transitions.map((t) => {
      const change = items.get(`transition:${t.id}`)!.change
      const color = COLORS[change]
      return {
        id: t.id,
        source: t.from,
        target: t.to,
        label: truncate(t.trigger),
        animated: change === 'added',
        style: {
          stroke: color,
          strokeWidth: change === 'unchanged' ? 1.5 : 2,
          strokeDasharray: change === 'removed' ? '6 4' : undefined
        },
        markerEnd: { type: MarkerType.ArrowClosed, color },
        labelStyle: { fill: 'var(--ev-c-text-2)', fontSize: 11 },
        labelBgStyle: { fill: 'var(--color-background)' }
      }
    })

    return { nodes, edges, items }
  }, [graph, preview])

  const selected = selectedKey ? items.get(selectedKey) : undefined

  return (
    <div className="canvas-layout">
      <div className="canvas">
        <ReactFlow
          key={preview ? 'preview' : 'current'}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          forceColorMode="dark"
          fitView
          nodesConnectable={false}
          onNodeClick={(_, node) => setSelectedKey(`state:${node.id}`)}
          onEdgeClick={(_, edge) => setSelectedKey(`transition:${edge.id}`)}
          onPaneClick={() => setSelectedKey(null)}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <aside className="inspector">
        {selected ? (
          <>
            <p className="muted inspector-kind">
              {selected.kind}
              {selected.change !== 'unchanged' && (
                <span className="badge" style={{ borderColor: COLORS[selected.change] }}>
                  {selected.change}
                </span>
              )}
            </p>
            <h3>{selected.title}</h3>
            {selected.detail && <p>{selected.detail}</p>}
            <h4>Source</h4>
            {selected.sources.length ? (
              <ul className="sources">
                {selected.sources.map((s) => (
                  <li key={`${s.path}:${s.startLine}-${s.endLine}`}>
                    <code>
                      {s.path}:{s.startLine}
                      {s.endLine !== s.startLine && `–${s.endLine}`}
                    </code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Not in the code yet.</p>
            )}
          </>
        ) : (
          <p className="muted">Click a state or transition to inspect it.</p>
        )}
      </aside>
    </div>
  )
}
