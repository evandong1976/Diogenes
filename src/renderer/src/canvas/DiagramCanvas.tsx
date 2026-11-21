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
import type { Change, Diagram, DiagramEdge, DiagramNode } from './diagrams'
import { layeredLayout } from './layout'

type CardNode = Node<DiagramNode, 'card'>

// Design system: proposed changes are marigold, removals are poppy, everything else is a connector.
const COLORS: Record<Change, string> = {
  unchanged: 'var(--dg-connector)',
  added: 'var(--dg-accent)',
  removed: 'var(--dg-danger)'
}

function CardNodeView({ data, selected }: NodeProps<CardNode>): React.JSX.Element {
  return (
    <div
      className="dg-node diagram-node"
      data-selected={selected ? 'true' : undefined}
      data-proposed={data.change === 'added' ? 'true' : undefined}
    >
      <Handle type="target" position={Position.Left} />
      <div className="diagram-node-header dg-label">
        <span>
          {data.kind} · {data.id}
        </span>
        {data.tag && <span className="dg-pill">{data.tag}</span>}
      </div>
      <div className="diagram-node-name">{data.label}</div>
      <div className="dg-data diagram-node-meta">{data.meta}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const nodeTypes = { card: CardNodeView }

function truncate(text: string, max = 34): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

type Selected = { kind: 'node'; item: DiagramNode } | { kind: 'edge'; item: DiagramEdge }

interface Props {
  diagram: Diagram
  /** Changing this refits the view, for example when a different graph loads. */
  viewKey: string
  canvasRef?: React.Ref<HTMLDivElement>
  /** Drawn above the diagram, inside the captured area. */
  overlay?: React.ReactNode
}

export function DiagramCanvas({ diagram, viewKey, canvasRef, overlay }: Props): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null)

  const { nodes, edges } = useMemo(() => {
    const live = diagram.edges.filter((e) => e.change !== 'removed')
    const positions = layeredLayout(
      diagram.roots,
      diagram.nodes.map((n) => n.id),
      live
    )
    const nodes: CardNode[] = diagram.nodes.map((n) => ({
      id: n.id,
      type: 'card',
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      data: n
    }))
    const edges: Edge[] = diagram.edges.map((e) => {
      const color = COLORS[e.change]
      return {
        id: e.id,
        source: e.from,
        target: e.to,
        label: truncate(e.label),
        style: {
          stroke: color,
          strokeWidth: 1,
          strokeDasharray: e.change === 'unchanged' ? undefined : '4 3'
        },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        labelStyle: { fill: 'var(--dg-text-2)', font: '400 10px var(--dg-font-bit)' },
        labelBgStyle: { fill: 'var(--dg-surface-2)', stroke: 'var(--dg-border-strong)' },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 2
      }
    })
    return { nodes, edges }
  }, [diagram])

  const selected: Selected | undefined = useMemo(() => {
    if (selectedId?.kind === 'node') {
      const item = diagram.nodes.find((n) => n.id === selectedId.id)
      return item && { kind: 'node', item }
    }
    if (selectedId?.kind === 'edge') {
      const item = diagram.edges.find((e) => e.id === selectedId.id)
      return item && { kind: 'edge', item }
    }
    return undefined
  }, [diagram, selectedId])

  const empty = diagram.nodes.length === 0

  return (
    <div className="canvas-layout">
      <div className="canvas dg-canvas" ref={canvasRef}>
        {empty ? (
          <div className="canvas-empty">
            <span className="dg-label">Nothing found at this level</span>
          </div>
        ) : (
          <ReactFlow
            key={viewKey}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            forceColorMode="dark"
            fitView
            nodesConnectable={false}
            onNodeClick={(_, node) => setSelectedId({ kind: 'node', id: node.id })}
            onEdgeClick={(_, edge) => setSelectedId({ kind: 'edge', id: edge.id })}
            onPaneClick={() => setSelectedId(null)}
            proOptions={{ hideAttribution: true }}
          >
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
        {overlay}
      </div>
      <aside className="inspector">
        {selected ? (
          <Inspector selected={selected} />
        ) : (
          <span className="dg-label">Select an item</span>
        )}
      </aside>
    </div>
  )
}

function Inspector({ selected }: { selected: Selected }): React.JSX.Element {
  const { item } = selected
  const title =
    selected.kind === 'node' ? selected.item.label : `${selected.item.from} → ${selected.item.to}`
  const kind = selected.kind === 'node' ? selected.item.kind : 'Connection'
  return (
    <>
      <div className="row">
        <span className="dg-label">{kind}</span>
        {item.change !== 'unchanged' && (
          <span className="dg-pill" style={{ color: COLORS[item.change] }}>
            {item.change === 'added' ? 'Proposed' : 'Replaced'}
          </span>
        )}
      </div>
      <h2 className="title">{title}</h2>
      {item.detail && <p className="muted">{item.detail}</p>}
      <span className="dg-label">Source</span>
      {item.sources.length ? (
        <ul className="sources dg-data">
          {item.sources.map((s) => (
            <li key={`${s.path}:${s.startLine}-${s.endLine}`}>
              {s.path}
              {s.startLine !== undefined && `:${s.startLine}`}
              {s.endLine !== undefined && s.endLine !== s.startLine && `–${s.endLine}`}
            </li>
          ))}
        </ul>
      ) : (
        <p className="dg-data">
          {selected.kind === 'node' ? 'Not in code yet' : 'No source cited'}
        </p>
      )}
    </>
  )
}
