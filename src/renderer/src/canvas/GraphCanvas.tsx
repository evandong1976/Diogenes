import { useMemo, useState } from 'react'
import {
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

type StateNodeData = {
  id: string
  label: string
  initial: boolean
  change: Change
  sourceCount: number
}
type StateNode = Node<StateNodeData, 'state'>

// Design system: proposed changes are marigold, removals are poppy, everything else is a connector.
const COLORS: Record<Change, string> = {
  unchanged: 'var(--dg-connector)',
  added: 'var(--dg-accent)',
  removed: 'var(--dg-danger)'
}

function StateNodeView({ data, selected }: NodeProps<StateNode>): React.JSX.Element {
  return (
    <div
      className="dg-node state-node"
      data-selected={selected ? 'true' : undefined}
      data-proposed={data.change === 'added' ? 'true' : undefined}
    >
      <Handle type="target" position={Position.Left} />
      <div className="state-node-header dg-label">
        <span>State · {data.id}</span>
        {data.initial && <span className="dg-pill">Start</span>}
      </div>
      <div className="state-node-name">{data.label}</div>
      <div className="dg-data">
        {data.sourceCount ? `${data.sourceCount} source refs` : 'Not in code yet'}
      </div>
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
        id: s.id,
        label: s.label,
        initial: s.id === graph.initialStateId,
        change: items.get(`state:${s.id}`)!.change,
        sourceCount: items.get(`state:${s.id}`)!.sources.length
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
        style: {
          stroke: color,
          strokeWidth: 1,
          strokeDasharray: change === 'unchanged' ? undefined : '4 3'
        },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        labelStyle: { fill: 'var(--dg-text-2)', font: '400 10px var(--dg-font-bit)' },
        labelBgStyle: { fill: 'var(--dg-surface-2)', stroke: 'var(--dg-border-strong)' },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 2
      }
    })

    return { nodes, edges, items }
  }, [graph, preview])

  const selected = selectedKey ? items.get(selectedKey) : undefined

  return (
    <div className="canvas-layout">
      <div className="canvas dg-canvas">
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
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <aside className="inspector">
        {selected ? (
          <>
            <div className="row">
              <span className="dg-label">{selected.kind}</span>
              {selected.change !== 'unchanged' && (
                <span className="dg-pill" style={{ color: COLORS[selected.change] }}>
                  {selected.change === 'added' ? 'Proposed' : 'Replaced'}
                </span>
              )}
            </div>
            <h2 className="title">{selected.title}</h2>
            {selected.detail && <p className="muted">{selected.detail}</p>}
            <span className="dg-label">Source</span>
            {selected.sources.length ? (
              <ul className="sources dg-data">
                {selected.sources.map((s) => (
                  <li key={`${s.path}:${s.startLine}-${s.endLine}`}>
                    {s.path}:{s.startLine}
                    {s.endLine !== s.startLine && `–${s.endLine}`}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="dg-data">Not in the code yet</p>
            )}
          </>
        ) : (
          <span className="dg-label">Select a state or transition</span>
        )}
      </aside>
    </div>
  )
}
