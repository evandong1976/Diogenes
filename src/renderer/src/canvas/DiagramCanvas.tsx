import { createContext, useContext, useMemo, useState } from 'react'
import {
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChangeset,
  type Node,
  type NodeChangeset,
  type NodeProps,
  type ReactFlowInstance
} from '@xyflow/react'
import type { Change, Diagram, DiagramEdge, DiagramNode, PortType } from './diagrams'
import { layeredLayout, type Point } from './layout'
import {
  DRAG_COMPONENT,
  DRAG_FILE,
  PALETTE,
  PROTOCOL_CODE,
  PROTOCOL_PORT_TYPE,
  formatSource,
  guessKind,
  iconFor,
  middleTruncate,
  newComponent,
  outProtocol,
  useWorkspace
} from './components'
import type { CatalogProtocol } from '../../../shared/catalog'
import { brandFor, methodOf, shapeFor, type Brand } from './brands'

type ComponentData = DiagramNode & {
  outProtocol: CatalogProtocol
  /** Files the user linked by dropping them on the component. */
  linked: string[]
}
type ComponentNode = Node<ComponentData, 'component'>

// Edges take their port type's color; proposed are marigold, removals poppy.
const COLORS: Record<Change, string> = {
  unchanged: 'var(--dg-connector)',
  added: 'var(--dg-accent)',
  removed: 'var(--dg-danger)'
}
const PORT_COLORS: Record<PortType, string> = {
  http: 'var(--dg-port-http)',
  data: 'var(--dg-port-data)',
  auth: 'var(--dg-port-auth)',
  event: 'var(--dg-port-event)'
}
const edgeColor = (e: DiagramEdge): string =>
  e.change === 'unchanged' ? PORT_COLORS[e.type] : COLORS[e.change]

const isDraft = (id: string): boolean => id.startsWith('draft-')

/** Lets a component accept files dropped from the sidebar. */
const LinkFileContext = createContext<(nodeId: string, path: string) => void>(() => {})

function KindIcon({ kind }: { kind: DiagramNode['catalogKind'] }): React.JSX.Element {
  return (
    <svg
      className="dg-node__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: iconFor(kind ?? 'generic') }}
    />
  )
}

function BrandIcon({ brand }: { brand: Brand }): React.JSX.Element {
  return (
    <svg className="dg-node__icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={brand.path} />
    </svg>
  )
}

/** The canvas component card: header, optional file rows, status, evidence footer (v0.3). */
function ComponentView({ id, data, selected }: NodeProps<ComponentNode>): React.JSX.Element {
  const linkFile = useContext(LinkFileContext)
  const [dropping, setDropping] = useState(false)
  const kind = guessKind(data)
  const brand = brandFor(data)
  const shape = shapeFor(data, kind)
  const method = shape === 'endpoint' ? methodOf(data) : undefined
  const resolution =
    data.change === 'added' ? 'proposed' : data.unresolved ? 'unresolved' : data.resolution
  const state = selected ? 'selected' : data.change === 'removed' ? 'error' : undefined
  const [first, ...rest] = data.sources
  // Rows list a component's files when it spans several, like the routes table in the mock.
  const rows = data.sources.length > 1 ? data.sources.slice(0, 4) : []

  return (
    <div
      className="dg-node component"
      data-shape={shape}
      data-branded={brand ? true : undefined}
      style={
        brand
          ? ({ '--brand': brand.hex, '--brand-ink': brand.ink } as React.CSSProperties)
          : undefined
      }
      data-resolution={resolution}
      data-state={state}
      data-dropping={dropping || undefined}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_FILE)) return
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        const path = e.dataTransfer.getData(DRAG_FILE)
        setDropping(false)
        if (!path) return
        e.preventDefault()
        e.stopPropagation()
        linkFile(id, path)
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="dg-port dg-port--in"
        data-protocol={data.outProtocol}
      />
      {shape === 'view' && (
        <div className="component__chrome" aria-hidden="true">
          <i />
          <i />
          <i />
          <span className="dg-data">{data.detail ?? '/'}</span>
        </div>
      )}
      <div className="dg-node__header">
        <span className="component__tile" title={brand?.title}>
          {brand ? <BrandIcon brand={brand} /> : <KindIcon kind={kind} />}
        </span>
        {method && (
          <span className="component__method" data-method={method}>
            {method}
          </span>
        )}
        <span className="dg-node__lines">
          <span className="dg-node__title">{data.label}</span>
          <span className="dg-node__attr">{data.detail ?? data.meta}</span>
        </span>
        {data.tag && <span className="dg-node__metric">{data.tag}</span>}
        <span className="dg-node__type">{brand?.title ?? data.type ?? data.kind}</span>
      </div>
      {rows.length > 0 && (
        <ul className="component__rows">
          {rows.map((s) => (
            <li key={formatSource(s)} className="dg-data">
              <span>{s.path.split('/').slice(-1)[0]}</span>
              <span>
                {s.startLine !== undefined ? `${s.startLine}–${s.endLine ?? s.startLine}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {data.unresolved && (
        <div className="dg-node__status" data-tone="unresolved">
          Couldn&apos;t pin this down in code
        </div>
      )}
      <div className="dg-node__footer">
        <span className="dg-evidence" title={first ? formatSource(first) : undefined}>
          <span className="dg-evidence__path">
            {first ? middleTruncate(formatSource(first)) : 'Not in repo'}
          </span>
          {rest.length > 0 && <span className="dg-evidence__more">+{rest.length}</span>}
        </span>
        <span className="dg-node__output">
          <span className="dg-node__output-code">{PROTOCOL_CODE[data.outProtocol]}</span>▾
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="dg-port dg-port--out"
        data-protocol={data.outProtocol}
      />
    </div>
  )
}

const nodeTypes = { component: ComponentView }

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
  const { draft, setDraft, focusFile, levelTag } = useWorkspace()
  const [selectedId, setSelectedId] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null)
  const [rf, setRf] = useState<ReactFlowInstance<ComponentNode> | null>(null)
  // Positions while a drag is in progress; committed to the draft when it ends.
  const [moving, setMoving] = useState<Record<string, Point>>({})
  const [zoom, setZoom] = useState(1)
  // React Flow reports each card's measured size; controlled nodes must hand it back to show.
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({})

  // The level's diagram plus what the user added: drafted components, edges and file links.
  const merged = useMemo(() => {
    const nodes = [
      ...diagram.nodes.map((n) => {
        const linked = draft.links[n.id] ?? []
        return linked.length
          ? { ...n, sources: [...n.sources, ...linked.map((path) => ({ path }))] }
          : n
      }),
      ...draft.nodes.map((n) => ({
        ...n,
        sources: (draft.links[n.id] ?? []).map((path) => ({ path }))
      }))
    ]
    const ids = new Set(nodes.map((n) => n.id))
    const edges = [...diagram.edges, ...draft.edges.filter((e) => ids.has(e.from) && ids.has(e.to))]
    return { nodes, edges }
  }, [diagram, draft])

  const layout = useMemo(() => {
    const live = diagram.edges.filter((e) => e.change !== 'removed')
    return layeredLayout(
      diagram.roots,
      diagram.nodes.map((n) => n.id),
      live
    )
  }, [diagram])

  const focusIds = useMemo(
    () =>
      focusFile
        ? new Set(
            merged.nodes.filter((n) => n.sources.some((s) => s.path === focusFile)).map((n) => n.id)
          )
        : null,
    [merged, focusFile]
  )

  const nodes: ComponentNode[] = merged.nodes.map((n) => ({
    id: n.id,
    type: 'component',
    position: moving[n.id] ?? draft.positions[n.id] ?? layout.get(n.id) ?? { x: 0, y: 0 },
    selected: selectedId?.kind === 'node' && selectedId.id === n.id,
    deletable: isDraft(n.id),
    measured: sizes[n.id],
    className: focusIds ? (focusIds.has(n.id) ? 'is-focus' : 'is-dim') : undefined,
    data: {
      ...n,
      outProtocol: outProtocol(n, merged.edges),
      linked: draft.links[n.id] ?? []
    }
  }))

  const edges: Edge[] = merged.edges.map((e) => {
    const color = edgeColor(e)
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.label ? truncate(e.label) : undefined,
      selected: selectedId?.kind === 'edge' && selectedId.id === e.id,
      deletable: isDraft(e.id),
      // React Flow's default edge is a cubic curve with horizontal tangents, as v0.2 specifies.
      style: {
        stroke: color,
        strokeWidth: 'var(--dg-edge-w)',
        strokeOpacity: 0.85,
        strokeDasharray: e.change === 'unchanged' ? undefined : '5 4'
      },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      labelStyle: { fill: 'var(--dg-text-2)', font: '400 10px var(--dg-font-bit)' },
      labelBgStyle: { fill: 'var(--dg-surface-2)', stroke: 'var(--dg-border-strong)' },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 2
    }
  })

  const remove = (nodeIds: string[], edgeIds: string[]): void => {
    if (!nodeIds.length && !edgeIds.length) return
    setDraft((d) => ({
      ...d,
      nodes: d.nodes.filter((n) => !nodeIds.includes(n.id)),
      edges: d.edges.filter(
        (e) => !edgeIds.includes(e.id) && !nodeIds.includes(e.from) && !nodeIds.includes(e.to)
      )
    }))
    setSelectedId(null)
  }

  const onNodesChange = (changeset: NodeChangeset<ComponentNode>): void => {
    const changes = changeset.toArray()
    const measured: typeof sizes = {}
    for (const n of changeset.applyTo(nodes)) {
      const m = n.measured
      if (
        m?.width &&
        m.height &&
        (sizes[n.id]?.width !== m.width || sizes[n.id]?.height !== m.height)
      )
        measured[n.id] = { width: m.width, height: m.height }
    }
    if (Object.keys(measured).length) setSizes((s) => ({ ...s, ...measured }))
    const next = { ...moving }
    const done: Record<string, Point> = {}
    for (const c of changes) {
      if (c.type !== 'position' || !c.position) continue
      if (c.dragging) next[c.id] = c.position
      else {
        done[c.id] = c.position
        delete next[c.id]
      }
    }
    if (changes.some((c) => c.type === 'position')) setMoving(next)
    if (Object.keys(done).length)
      setDraft((d) => ({ ...d, positions: { ...d.positions, ...done } }))
    remove(
      changes.filter((c) => c.type === 'remove' && isDraft(c.id)).map((c) => c.id),
      []
    )
  }

  const onEdgesChange = (changeset: EdgeChangeset): void =>
    remove(
      [],
      changeset
        .toArray()
        .filter((c) => c.type === 'remove' && isDraft(c.id))
        .map((c) => c.id)
    )

  const onConnect = (c: Connection): void => {
    const from = merged.nodes.find((n) => n.id === c.source)
    if (!from || c.source === c.target) return
    const edge: DiagramEdge = {
      id: `draft-e-${crypto.randomUUID().slice(0, 8)}`,
      from: c.source,
      to: c.target,
      label: '',
      type: PROTOCOL_PORT_TYPE(outProtocol(from, merged.edges)),
      change: 'added',
      sources: []
    }
    setDraft((d) => ({ ...d, edges: [...d.edges, edge] }))
  }

  const onDrop = (e: React.DragEvent): void => {
    const template = e.dataTransfer.getData(DRAG_COMPONENT)
    const node = template && newComponent(template)
    if (!node || !rf) return
    e.preventDefault()
    const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    setDraft((d) => ({
      ...d,
      nodes: [...d.nodes, node],
      positions: { ...d.positions, [node.id]: { x: at.x - 130, y: at.y - 20 } }
    }))
    setSelectedId({ kind: 'node', id: node.id })
  }

  const linkFile = (nodeId: string, path: string): void =>
    setDraft((d) => {
      const current = d.links[nodeId] ?? []
      const own = merged.nodes.find((n) => n.id === nodeId)?.sources.some((s) => s.path === path)
      if (own) return d
      return { ...d, links: { ...d.links, [nodeId]: [...current, path] } }
    })

  const autoLayout = (): void => {
    // Indexed components go back to the layout; drafted ones keep where the user put them.
    setDraft((d) => ({
      ...d,
      positions: Object.fromEntries(Object.entries(d.positions).filter(([id]) => isDraft(id)))
    }))
    requestAnimationFrame(() =>
      rf?.fitView({
        duration: 200,
        maxZoom: 1,
        padding: { top: '64px', x: '24px', bottom: '24px' }
      })
    )
  }

  const selected: Selected | undefined = useMemo(() => {
    if (selectedId?.kind === 'node') {
      const item = merged.nodes.find((n) => n.id === selectedId.id)
      return item && { kind: 'node', item }
    }
    if (selectedId?.kind === 'edge') {
      const item = merged.edges.find((e) => e.id === selectedId.id)
      return item && { kind: 'edge', item }
    }
    return undefined
  }, [merged, selectedId])

  const empty = merged.nodes.length === 0

  return (
    <div className="canvas-layout">
      <div
        className="canvas dg-canvas--dots"
        ref={canvasRef}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_COMPONENT)) e.preventDefault()
        }}
        onDrop={onDrop}
      >
        <LinkFileContext.Provider value={linkFile}>
          <ReactFlow
            key={viewKey}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            forceColorMode="dark"
            fitView
            // Leaves room for the toolbar and doesn't blow small diagrams up past 100%.
            fitViewOptions={{ padding: { top: '64px', x: '24px', bottom: '24px' }, maxZoom: 1 }}
            onInit={setRf}
            onMove={(_, v) => setZoom(v.zoom)}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedId({ kind: 'node', id: node.id })}
            onEdgeClick={(_, edge) => setSelectedId({ kind: 'edge', id: edge.id })}
            onPaneClick={() => setSelectedId(null)}
            deleteKeyCode={['Backspace', 'Delete']}
            proOptions={{ hideAttribution: true }}
          >
            <Controls showInteractive={false} />
          </ReactFlow>
        </LinkFileContext.Provider>
        <div className="canvas-toolbar" role="toolbar" aria-label="Canvas">
          {PALETTE.map((p) => (
            <span
              key={p.id}
              className="palette-item"
              draggable
              title={`Drag onto the canvas to add a ${p.name.toLowerCase()}`}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_COMPONENT, p.id)
                e.dataTransfer.effectAllowed = 'copy'
              }}
            >
              <KindIcon kind={p.kind} />
              {p.name}
            </span>
          ))}
          <span className="toolbar-divider" />
          <button className="dg-btn dg-btn--ghost" onClick={autoLayout}>
            Auto-layout
          </button>
          <span className="canvas-toolbar__level dg-data">
            <span>{levelTag}</span> {Math.round(zoom * 100)}%
          </span>
        </div>
        {empty && (
          <div className="canvas-empty canvas-hint">
            <span className="dg-label">
              Nothing found at this level. Drag a component from the toolbar to start.
            </span>
          </div>
        )}
        {overlay}
      </div>
      <aside className="inspector">
        {selected ? (
          <Inspector
            selected={selected}
            linked={selected.kind === 'node' ? (draft.links[selected.item.id] ?? []) : []}
            onRename={(label) =>
              setDraft((d) => ({
                ...d,
                nodes: d.nodes.map((n) => (n.id === selected.item.id ? { ...n, label } : n))
              }))
            }
            onUnlink={(path) =>
              setDraft((d) => ({
                ...d,
                links: {
                  ...d.links,
                  [selected.item.id]: (d.links[selected.item.id] ?? []).filter((p) => p !== path)
                }
              }))
            }
            onRemove={() =>
              selected.kind === 'node'
                ? remove([selected.item.id], [])
                : remove([], [selected.item.id])
            }
          />
        ) : (
          <span className="dg-label">Select a component</span>
        )}
      </aside>
    </div>
  )
}

function Inspector({
  selected,
  linked,
  onRename,
  onUnlink,
  onRemove
}: {
  selected: Selected
  linked: string[]
  onRename(label: string): void
  onUnlink(path: string): void
  onRemove(): void
}): React.JSX.Element {
  const { item } = selected
  const draft = isDraft(item.id)
  const title =
    selected.kind === 'node' ? selected.item.label : `${selected.item.from} → ${selected.item.to}`
  const kind = selected.kind === 'node' ? (selected.item.type ?? selected.item.kind) : 'Connection'
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
      {draft && selected.kind === 'node' ? (
        <input
          className="dg-input"
          aria-label="Component name"
          value={selected.item.label}
          onChange={(e) => onRename(e.target.value)}
        />
      ) : (
        <h2 className="title">{title}</h2>
      )}
      {item.detail && <p className="muted">{item.detail}</p>}
      <div className="dg-evidence-list">
        <div className="dg-evidence-list__head">
          <span>{item.sources.length} sources</span>
        </div>
        {item.sources.length ? (
          item.sources.map((s) => {
            const isLinked = linked.includes(s.path) && s.startLine === undefined
            return (
              <div key={formatSource(s)} className="dg-evidence-list__row">
                <span className="dg-evidence-list__kind">{isLinked ? 'LINK' : 'CODE'}</span>
                <span className="dg-evidence__path" title={s.path}>
                  {s.path}
                </span>
                {isLinked ? (
                  <button
                    className="link-x"
                    aria-label={`Unlink ${s.path}`}
                    onClick={() => onUnlink(s.path)}
                  >
                    ✕
                  </button>
                ) : (
                  <span className="dg-evidence-list__range">
                    {s.startLine !== undefined ? `${s.startLine}–${s.endLine ?? s.startLine}` : ''}
                  </span>
                )}
              </div>
            )
          })
        ) : (
          <p className="dg-data">
            {selected.kind === 'node'
              ? 'Not in code yet. Drag a file from the sidebar onto it to link one.'
              : 'No source cited'}
          </p>
        )}
      </div>
      {draft && (
        <button className="dg-btn dg-btn--danger" onClick={onRemove}>
          Remove
        </button>
      )}
    </>
  )
}
