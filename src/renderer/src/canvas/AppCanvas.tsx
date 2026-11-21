import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
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
import type { CatalogGraph } from '../../../shared/catalog'
import type { WhiteboardEdit } from '../../../shared/design'
import { flowKinds, type AppFlow, type FlowKind } from '../../../shared/gemini'
import { brandFor } from './brands'
import {
  KIND_LABEL,
  allBoxes,
  applyWhiteboardEdit,
  boxComponent,
  changeBrief,
  flowLayout,
  newBox,
  newLink,
  newNote,
  type Box,
  type BoxComponent,
  type FlowDraft,
  type Link,
  type Note
} from './flow'
import type { Point } from './layout'
import { PaneToggle } from './PaneToggle'
import { buildStatus, type WhiteboardBuild } from './build'
import { useWorkspace } from './components'

// React Flow node data must be a plain object type; interfaces don't qualify.
type Plain<T> = { [K in keyof T]: T[K] }
/** How a box or arrow differs from the engineer's draft while a chat proposal is previewed. */
type Mark = 'added' | 'removed' | 'changed' | undefined
type BoxNode = Node<Plain<Box> & { dim: boolean; mark: Mark }, 'box'>

/** A whiteboard edit the design chat proposed, from turn `turnId`. */
export type ChatProposal = { turnId: string; edit: WhiteboardEdit }
type NoteNode = Node<Plain<Note>, 'note'>
type AnyNode = BoxNode | NoteNode

/** Lets a sticky note edit its own text. */
const NoteTextContext = createContext<(id: string, text: string) => void>(() => {})

/** The product's logo in its own color, or `fallback` when the box isn't a known product. */
function Brand({
  box,
  fallback = null
}: {
  box: Box
  fallback?: React.ReactNode
}): React.ReactNode {
  const brand = brandFor({ id: box.id, label: box.name, detail: box.summary })
  if (!brand) return fallback
  return (
    <span
      className="flow-brand"
      title={brand.title}
      style={{ background: brand.hex, color: brand.ink }}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d={brand.path} />
      </svg>
    </span>
  )
}

function Ports(): React.JSX.Element {
  return (
    <>
      <Handle type="target" position={Position.Left} className="flow-port" />
      <Handle type="source" position={Position.Right} className="flow-port" />
    </>
  )
}

/** One of the four whiteboard shapes. */
function BoxView({ data, selected }: NodeProps<BoxNode>): React.JSX.Element {
  const common = {
    'data-selected': selected || undefined,
    'data-proposed': data.proposed || undefined,
    'data-dim': data.dim || undefined,
    'data-mark': data.mark
  }
  const tag =
    data.mark === 'removed' ? (
      <span className="flow-tag flow-tag--removed">Remove</span>
    ) : data.mark ? (
      <span className="flow-tag flow-tag--chat">Chat</span>
    ) : (
      data.proposed && <span className="flow-tag">Proposed</span>
    )

  if (data.kind === 'screen')
    return (
      <div className="flow-box flow-screen" {...common}>
        <Ports />
        <div className="flow-screen__chrome">
          <i />
          <i />
          <i />
          <span>{data.name}</span>
          {tag}
        </div>
        <div className="flow-screen__body" aria-hidden="true">
          <b />
          <b />
          <b className="short" />
        </div>
        {data.summary && <p className="flow-summary">{data.summary}</p>}
      </div>
    )

  if (data.kind === 'data')
    return (
      <div className="flow-box flow-data" {...common}>
        <Ports />
        <div className="flow-head">
          <Brand box={data} />
          <span className="flow-name">{data.name}</span>
          {tag}
        </div>
        {data.tables.length > 0 ? (
          <ul className="flow-tables">
            {data.tables.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        ) : (
          data.summary && <p className="flow-summary">{data.summary}</p>
        )}
      </div>
    )

  return (
    <div className={`flow-box flow-${data.kind}`} {...common}>
      <Ports />
      <div className="flow-head">
        {data.kind === 'logic' ? (
          <span className="flow-glyph" aria-hidden="true">
            {'</>'}
          </span>
        ) : (
          <Brand
            box={data}
            fallback={
              <span className="flow-glyph" aria-hidden="true">
                ↗
              </span>
            }
          />
        )}
        <span className="flow-name">{data.name}</span>
        {tag}
      </div>
      {data.summary && <p className="flow-summary">{data.summary}</p>}
    </div>
  )
}

function NoteView({ id, data, selected }: NodeProps<NoteNode>): React.JSX.Element {
  const setText = useContext(NoteTextContext)
  const ref = useRef<HTMLTextAreaElement>(null)
  // A new note is ready to type into. autoFocus can't: React Flow shows a node only once measured.
  useEffect(() => {
    if (data.text) return
    const t = setTimeout(() => ref.current?.focus(), 60)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on mount only
  }, [])
  return (
    <div className="flow-note" data-selected={selected || undefined}>
      <textarea
        ref={ref}
        className="nodrag"
        aria-label="Instruction"
        placeholder="What should change?"
        value={data.text}
        onChange={(e) => setText(id, e.target.value)}
      />
      <Handle type="source" position={Position.Bottom} className="flow-port flow-port--note" />
    </div>
  )
}

const nodeTypes = { box: BoxView, note: NoteView }

interface Props {
  flow: AppFlow
  draft: FlowDraft
  setDraft(update: (d: FlowDraft) => FlowDraft): void
  /** Changing this refits the view. */
  viewKey: string
  /** A file picked in the sidebar: boxes without it fade. */
  focusFile: string | null
  onOpenLogic(box: Box): void
  /** Toolbar content on the left: where the map came from, re-read button. */
  status: React.ReactNode
  /** The indexed catalog, to tell the design chat which component a box is. Null without one. */
  catalog: CatalogGraph | null
  /** A chat proposal to preview on the canvas, with Accept and Reject. */
  proposal?: ChatProposal | null
  onDecide?(turnId: string, accept: boolean): void
  /** The coding run building the last accepted edit in the codebase. */
  build?: WhiteboardBuild | null
  onDismissBuild?(): void
}

export function AppCanvas({
  flow,
  draft,
  setDraft,
  viewKey,
  focusFile,
  onOpenLogic,
  status,
  catalog,
  proposal = null,
  onDecide,
  build = null,
  onDismissBuild
}: Props): React.JSX.Element {
  const { panes, onSelectComponent } = useWorkspace()
  const [rf, setRf] = useState<ReactFlowInstance<AnyNode> | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [moving, setMoving] = useState<Record<string, Point>>({})
  // Controlled nodes must be handed back the size React Flow measured, or they stay hidden.
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({})

  // With a chat proposal open, the canvas shows the draft as it would be after accepting it.
  const shown = useMemo(
    () => (proposal ? applyWhiteboardEdit(flow, draft, proposal.edit) : draft),
    [flow, draft, proposal]
  )
  const removedSet = useMemo(() => new Set(shown.removed ?? []), [shown.removed])
  const markOf = (id: string): Mark => {
    if (removedSet.has(id)) return 'removed'
    if (!proposal) return undefined
    if (!draft.boxes.some((b) => b.id === id) && shown.boxes.some((b) => b.id === id))
      return 'added'
    if (shown.changed?.[id] !== draft.changed?.[id]) return 'changed'
    return undefined
  }
  const boxes = useMemo((): Box[] => allBoxes(flow, shown), [flow, shown])
  const layout = useMemo(() => flowLayout(boxes), [boxes])
  const byId = useMemo(() => new Map(boxes.map((b) => [b.id, b])), [boxes])

  const position = (id: string, fallback: Point): Point =>
    moving[id] ?? draft.positions[id] ?? fallback

  const nodes: AnyNode[] = [
    ...boxes.map((b): BoxNode => ({
      id: b.id,
      type: 'box',
      position: position(b.id, layout.get(b.id) ?? { x: 0, y: 0 }),
      selected: selectedId === b.id,
      deletable: !!b.proposed,
      measured: sizes[b.id],
      data: { ...b, dim: !!focusFile && !b.paths.includes(focusFile), mark: markOf(b.id) }
    })),
    ...draft.notes.map((n, i): NoteNode => {
      const target = n.target ? layout.get(n.target) : undefined
      return {
        id: n.id,
        type: 'note',
        position: position(
          n.id,
          target ? { x: target.x + 40, y: target.y - 150 } : { x: -280, y: i * 160 }
        ),
        selected: selectedId === n.id,
        measured: sizes[n.id],
        data: n
      }
    })
  ]

  const edges: Edge[] = [
    ...([...flow.links, ...shown.links] as Link[]).map((l): Edge => {
      const gone = removedSet.has(l.id)
      const fromChat = !!proposal && !draft.links.some((d) => d.id === l.id) && !!l.proposed
      const color = gone
        ? 'var(--dg-danger)'
        : fromChat || l.proposed
          ? 'var(--dg-accent)'
          : 'var(--dg-text-3)'
      return {
        id: l.id,
        source: l.from,
        target: l.to,
        label: l.label || undefined,
        selected: selectedId === l.id,
        deletable: !!l.proposed,
        style: {
          stroke: color,
          strokeWidth: 1.5,
          strokeDasharray: gone ? '2 4' : l.proposed ? '6 4' : undefined,
          opacity: gone ? 0.7 : undefined
        },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
        labelStyle: { fill: 'var(--dg-text-2)', font: '500 11px var(--dg-font-ui)' },
        labelBgStyle: { fill: 'var(--dg-bg)' },
        labelBgPadding: [4, 2] as [number, number]
      }
    }),
    // A note's pin to its box.
    ...draft.notes
      .filter((n) => n.target && byId.has(n.target))
      .map((n): Edge => ({
        id: `pin:${n.id}`,
        source: n.id,
        target: n.target!,
        deletable: false,
        selectable: false,
        style: { stroke: 'var(--dg-warn)', strokeWidth: 1.5, strokeDasharray: '2 4' }
      }))
  ]

  const removeIds = (ids: string[]): void => {
    if (!ids.length) return
    const gone = new Set(ids)
    setDraft((d) => ({
      ...d,
      boxes: d.boxes.filter((b) => !gone.has(b.id)),
      notes: d.notes
        .filter((n) => !gone.has(n.id))
        .map((n) => (n.target && gone.has(n.target) ? { ...n, target: undefined } : n)),
      links: d.links.filter((l) => !gone.has(l.id) && !gone.has(l.from) && !gone.has(l.to))
    }))
    setSelectedId(null)
  }

  const onNodesChange = (changeset: NodeChangeset<AnyNode>): void => {
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
    const changes = changeset.toArray()
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
    removeIds(changes.filter((c) => c.type === 'remove').map((c) => c.id))
  }

  const onEdgesChange = (changeset: EdgeChangeset): void =>
    removeIds(
      changeset
        .toArray()
        .filter((c) => c.type === 'remove')
        .map((c) => c.id)
    )

  const onConnect = (c: Connection): void => {
    if (c.source === c.target) return
    // Dragging from a note pins it to the box.
    if (draft.notes.some((n) => n.id === c.source)) {
      setDraft((d) => ({
        ...d,
        notes: d.notes.map((n) => (n.id === c.source ? { ...n, target: c.target } : n))
      }))
      return
    }
    if (!byId.has(c.target)) return
    setDraft((d) => ({ ...d, links: [...d.links, newLink(c.source, c.target)] }))
  }

  /** Middle of what's on screen, so new things appear where the engineer is looking. */
  const center = (): Point => {
    const pane = document.querySelector('.flow-canvas')?.getBoundingClientRect()
    if (!rf || !pane) return { x: 0, y: 0 }
    const p = rf.screenToFlowPosition({ x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 })
    return { x: p.x - 110, y: p.y - 60 }
  }

  const addBox = (kind: FlowKind): void => {
    const box = newBox(kind)
    setDraft((d) => ({
      ...d,
      boxes: [...d.boxes, box],
      positions: { ...d.positions, [box.id]: center() }
    }))
    setSelectedId(box.id)
  }

  const addNote = (target?: string): void => {
    const note = newNote(target)
    const at = target ? undefined : center()
    setDraft((d) => ({
      ...d,
      notes: [...d.notes, note],
      positions: at ? { ...d.positions, [note.id]: at } : d.positions
    }))
    setSelectedId(note.id)
  }

  const setNoteText = (id: string, text: string): void =>
    setDraft((d) => ({ ...d, notes: d.notes.map((n) => (n.id === id ? { ...n, text } : n)) }))

  const editBox = (id: string, patch: Partial<Box>): void =>
    setDraft((d) => ({ ...d, boxes: d.boxes.map((b) => (b.id === id ? { ...b, ...patch } : b)) }))

  const selectedBox = selectedId ? byId.get(selectedId) : undefined
  // A selected note stands for the box it's pinned to: that's what its instruction is about.
  const selectedNote = draft.notes.find((n) => n.id === selectedId)
  const focusBox = selectedBox ?? (selectedNote?.target ? byId.get(selectedNote.target) : undefined)
  const component = focusBox && !focusBox.proposed ? boxComponent(focusBox, catalog) : null
  const brief = changeBrief(flow, draft, catalog)

  // Tell the design chat which catalog component is selected, so a message can be about it.
  const componentKey = component && focusBox ? `${component.componentId}\0${focusBox.name}` : ''
  useEffect(() => {
    onSelectComponent(
      component && focusBox ? { componentId: component.componentId, label: focusBox.name } : null
    )
    // Keyed on the selection's identity, not the objects, so redraws don't re-report it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [componentKey])
  useEffect(() => () => onSelectComponent(null), [onSelectComponent])

  return (
    <div className="canvas-layout">
      <div className="canvas flow-canvas dg-canvas--dots">
        <NoteTextContext.Provider value={setNoteText}>
          <ReactFlow
            key={viewKey}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            forceColorMode="dark"
            fitView
            fitViewOptions={{ padding: { top: '72px', x: '32px', bottom: '32px' }, maxZoom: 1 }}
            onInit={setRf}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onEdgeClick={(_, e) => setSelectedId(e.id)}
            onPaneClick={() => setSelectedId(null)}
            deleteKeyCode={['Backspace', 'Delete']}
            proOptions={{ hideAttribution: true }}
          >
            <Controls showInteractive={false} />
          </ReactFlow>
        </NoteTextContext.Provider>
        <div className="canvas-toolbar" role="toolbar" aria-label="Canvas">
          <PaneToggle side="left" />
          <span className="toolbar-divider" />
          <div className="canvas-toolbar__scroll">
            {status}
            <span className="toolbar-divider" />
            {flowKinds.map((k) => (
              <button key={k} className="dg-btn dg-btn--ghost" onClick={() => addBox(k)}>
                + {KIND_LABEL[k]}
              </button>
            ))}
            <button className="dg-btn flow-note-btn" onClick={() => addNote(selectedBox?.id)}>
              + Note
            </button>
          </div>
          <span className="toolbar-divider" />
          <PaneToggle side="inspector" />
        </div>
        {proposal && (
          <div className="flow-proposal" role="region" aria-label="Proposed by the design chat">
            <span className="dg-label">Proposed by chat</span>
            <p className="flow-proposal__text">{proposal.edit.summary}</p>
            <div className="flow-proposal__actions">
              <button
                className="dg-btn dg-btn--ghost"
                onClick={() => onDecide?.(proposal.turnId, false)}
              >
                Reject
              </button>
              <button
                className="dg-btn dg-btn--primary"
                onClick={() => onDecide?.(proposal.turnId, true)}
              >
                Accept &amp; build
              </button>
            </div>
          </div>
        )}
        {!proposal && build && <BuildCard build={build} onDismiss={onDismissBuild} />}
      </div>
      <aside className="inspector" aria-label="Inspector" hidden={!panes.inspector}>
        <div className="inspector__head">
          <span className="dg-label">Inspector</span>
          <button
            type="button"
            className="dg-btn dg-btn--ghost pane-toggle"
            aria-label="Hide inspector"
            title="Hide inspector (⌘⇧\)"
            onClick={() => panes.setInspector(false)}
          >
            ⟩
          </button>
        </div>
        {selectedBox ? (
          <BoxInspector
            box={selectedBox}
            removed={removedSet.has(selectedBox.id)}
            onKeep={() =>
              setDraft((d) => ({
                ...d,
                removed: (d.removed ?? []).filter((id) => id !== selectedBox.id)
              }))
            }
            component={component}
            indexed={!!catalog}
            onEdit={(patch) => editBox(selectedBox.id, patch)}
            onNote={() => addNote(selectedBox.id)}
            onOpenLogic={() => onOpenLogic(selectedBox)}
            onRemove={() => removeIds([selectedBox.id])}
          />
        ) : (
          <div className="flow-brief">
            <span className="dg-label">Change request</span>
            {brief ? (
              <>
                <pre className="dg-data">{brief}</pre>
                <button
                  className="dg-btn dg-btn--primary"
                  onClick={() => void navigator.clipboard.writeText(brief)}
                >
                  Copy for agent
                </button>
              </>
            ) : (
              <p className="muted">
                Add a note or a new box to propose a change. Pin a note to a box by selecting the
                box first, or drag from the note&apos;s dot onto it.
              </p>
            )}
          </div>
        )}
      </aside>
    </div>
  )
}

/** Where the accepted change stands in the codebase: sent, coding, checking, built. */
function BuildCard({
  build,
  onDismiss
}: {
  build: WhiteboardBuild
  onDismiss?(): void
}): React.JSX.Element {
  const status = buildStatus(build)
  const files = build.handoff?.runs.at(-1)?.candidate?.files ?? []
  return (
    <div className="flow-proposal flow-build" data-tone={status.tone} role="status">
      <div className="flow-build__head">
        <span className="dg-label">Building in the codebase</span>
        <button className="link-x" aria-label="Dismiss" onClick={onDismiss}>
          ✕
        </button>
      </div>
      <p className="flow-proposal__text">{status.text}</p>
      {build.sent && (
        <p className="dg-data">
          Sent the change with {build.sent.files} source files · may edit{' '}
          {build.sent.scope.join(', ')}
        </p>
      )}
      {files.length > 0 && (
        <ul className="flow-build__files dg-data">
          {files.slice(0, 6).map((f) => (
            <li key={f}>{f}</li>
          ))}
          {files.length > 6 && <li>+{files.length - 6} more</li>}
        </ul>
      )}
    </div>
  )
}

function BoxInspector({
  box,
  removed,
  onKeep,
  component,
  indexed,
  onEdit,
  onNote,
  onOpenLogic,
  onRemove
}: {
  box: Box
  /** Marked for removal in the change request. */
  removed: boolean
  onKeep(): void
  /** The catalog component the design chat attaches for this box. */
  component: BoxComponent | null
  /** Whether the repo's catalog is loaded, to explain a missing component. */
  indexed: boolean
  onEdit(patch: Partial<Box>): void
  onNote(): void
  onOpenLogic(): void
  onRemove(): void
}): React.JSX.Element {
  return (
    <>
      <div className="row">
        <span className="dg-label">{KIND_LABEL[box.kind]}</span>
        {box.proposed && <span className="dg-pill flow-tag">Proposed</span>}
        {removed && <span className="dg-pill flow-tag flow-tag--removed">Remove</span>}
      </div>
      {removed && (
        <button className="dg-btn" onClick={onKeep}>
          Keep this box
        </button>
      )}
      {box.proposed ? (
        <>
          <input
            className="dg-input"
            aria-label="Name"
            value={box.name}
            onChange={(e) => onEdit({ name: e.target.value })}
          />
          <textarea
            className="dg-input"
            aria-label="What it does"
            placeholder="What it does"
            rows={3}
            value={box.summary}
            onChange={(e) => onEdit({ summary: e.target.value })}
          />
          {box.kind === 'data' && (
            <input
              className="dg-input"
              aria-label="Tables"
              placeholder="Tables, comma separated"
              value={box.tables.join(', ')}
              onChange={(e) =>
                onEdit({
                  tables: e.target.value
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean)
                })
              }
            />
          )}
        </>
      ) : (
        <>
          <h2 className="title">{box.name}</h2>
          {box.summary && <p className="muted">{box.summary}</p>}
          {box.tables.length > 0 && <p className="dg-data">Tables: {box.tables.join(', ')}</p>}
        </>
      )}
      {!box.proposed && (
        <p className="dg-data" title={component?.componentId}>
          {component
            ? `Chat: ${component.name} · ${component.componentId}`
            : indexed
              ? 'Chat: no indexed component matches these files'
              : 'Chat: waiting for the index'}
        </p>
      )}
      {box.paths.length > 0 && (
        <div className="dg-evidence-list">
          <div className="dg-evidence-list__head">
            <span>{box.paths.length} files</span>
          </div>
          {box.paths.map((p) => (
            <div key={p} className="dg-evidence-list__row">
              <span className="dg-evidence__path" title={p}>
                {p}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="row">
        <button className="dg-btn flow-note-btn" onClick={onNote}>
          + Note on this
        </button>
        {box.kind === 'logic' && !box.proposed && (
          <button className="dg-btn" onClick={onOpenLogic}>
            Open logic →
          </button>
        )}
        {box.proposed && (
          <button className="dg-btn dg-btn--danger" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
    </>
  )
}
