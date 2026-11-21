// The app canvas model: Gemini's map of how the app runs, plus what the engineer proposes on top
// (new boxes, new arrows, sticky-note instructions). Pure data, so the brief can be tested.
import type { CatalogGraph } from '../../../shared/catalog'
import type { WhiteboardEdit, WhiteboardSnapshot } from '../../../shared/design'
import type { AppFlow, FlowBox, FlowKind, FlowLink } from '../../../shared/gemini'
import type { Point } from './layout'

export type Box = FlowBox & { proposed?: boolean }
export type Link = FlowLink & { proposed?: boolean }

/** A sticky note: an instruction for the agent, pinned to a box or loose on the canvas. */
export interface Note {
  id: string
  text: string
  target?: string
}

/** A rename or rewrite of an existing box. */
export type BoxChange = Partial<Pick<Box, 'name' | 'summary' | 'tables'>>

export interface FlowDraft {
  boxes: Box[]
  links: Link[]
  notes: Note[]
  positions: Record<string, Point>
  /** Existing boxes and arrows the engineer wants gone. Still drawn, marked for removal. */
  removed?: string[]
  /** Changes to existing boxes, by ID. */
  changed?: Record<string, BoxChange>
}

export const emptyFlowDraft: FlowDraft = { boxes: [], links: [], notes: [], positions: {} }

export const KIND_LABEL: Record<FlowKind, string> = {
  screen: 'Screen',
  logic: 'Logic',
  service: 'Service',
  data: 'Data'
}

const COLUMN: Record<FlowKind, number> = { screen: 0, logic: 1, service: 2, data: 3 }
const COLUMN_W = 400
const ROW_H: Record<FlowKind, number> = { screen: 230, logic: 170, service: 150, data: 250 }

/** Whiteboard order, left to right: what the user sees, what decides, what it calls, what it keeps. */
export function flowLayout(boxes: Box[]): Map<string, Point> {
  const y: Record<FlowKind, number> = { screen: 0, logic: 0, service: 0, data: 0 }
  const at = new Map<string, Point>()
  for (const b of boxes) {
    at.set(b.id, { x: COLUMN[b.kind] * COLUMN_W, y: y[b.kind] })
    y[b.kind] += ROW_H[b.kind]
  }
  return at
}

const newId = (prefix: string): string => `${prefix}-${crypto.randomUUID().slice(0, 8)}`

export function newBox(kind: FlowKind): Box {
  return {
    id: newId('new'),
    kind,
    name: `New ${KIND_LABEL[kind].toLowerCase()}`,
    summary: '',
    tables: [],
    paths: [],
    proposed: true
  }
}

export const newNote = (target?: string): Note => ({ id: newId('note'), text: '', target })

export const newLink = (from: string, to: string, label = ''): Link => ({
  id: newId('link'),
  from,
  to,
  label,
  proposed: true
})

/** The catalog component a whiteboard box stands for. */
export type BoxComponent = { componentId: string; name: string }

const isUnder = (file: string, path: string): boolean =>
  file === path || file.startsWith(`${path.replace(/\/+$/, '')}/`)

/** Compares scores in order: the first entry that differs decides. */
function outranks(a: number[], b: number[]): boolean {
  const i = a.findIndex((v, k) => v !== b[k])
  return i !== -1 && a[i] > b[i]
}

/**
 * The catalog component a box is about, by the files they share. Whiteboard boxes come from
 * Gemini and have their own IDs; the design agent only knows catalog IDs, so the chat and the
 * brief need this to point the agent at the right component. Null when nothing overlaps.
 *
 * A component whose own files the box names outranks one that merely sits under a folder the
 * box names; then the component more fully inside the box wins, then the smaller one.
 */
export function boxComponent(box: Box, catalog: CatalogGraph | null): BoxComponent | null {
  if (!catalog || !box.paths.length) return null
  let best: { node: CatalogGraph['nodes'][number]; score: number[] } | null = null
  for (const node of catalog.nodes) {
    const files = [...new Set(node.sources.map((s) => s.path))]
    if (!files.length) continue
    const exact = files.filter((f) => box.paths.includes(f)).length
    const covered = files.filter((f) => box.paths.some((p) => isUnder(f, p))).length
    if (!covered) continue
    const score = [exact, covered / files.length, covered, -files.length]
    if (!best || outranks(score, best.score)) best = { node, score }
  }
  return best && { componentId: best.node.id, name: best.node.name }
}

/** Every box on the canvas with the draft's changes applied, removed ones included. */
export function allBoxes(flow: AppFlow, draft: FlowDraft): Box[] {
  return [
    ...flow.boxes.map((b) => (draft.changed?.[b.id] ? { ...b, ...draft.changed[b.id] } : b)),
    ...draft.boxes
  ]
}

/** What the design agent sees: the whiteboard as it would be after the draft, notes included. */
export function whiteboardOf(flow: AppFlow, draft: FlowDraft): WhiteboardSnapshot {
  const gone = new Set(draft.removed ?? [])
  const boxes = allBoxes(flow, draft).filter((b) => !gone.has(b.id))
  const ids = new Set(boxes.map((b) => b.id))
  return {
    boxes: boxes.map(({ id, kind, name, summary, tables, paths, proposed }) => ({
      id,
      kind,
      name,
      summary,
      tables,
      paths,
      ...(proposed && { proposed })
    })),
    links: [...flow.links, ...draft.links]
      .filter((l) => !gone.has(l.id) && ids.has(l.from) && ids.has(l.to))
      .map(({ id, from, to, label }) => ({ id, from, to, label })),
    notes: draft.notes
      .filter((n) => n.text.trim())
      .map((n) => ({
        text: n.text.trim(),
        ...(n.target && ids.has(n.target) && { target: n.target })
      }))
  }
}

/**
 * The draft with an agent's whiteboard edit applied. New pieces arrive as proposed; existing
 * ones are marked removed or changed, so the change request lists them. Arrows into a removed
 * box go with it.
 */
export function applyWhiteboardEdit(
  flow: AppFlow,
  draft: FlowDraft,
  edit: WhiteboardEdit
): FlowDraft {
  const isDraftBox = (id: string): boolean => draft.boxes.some((b) => b.id === id)
  const goneBoxes = new Set(edit.removeBoxIds)
  const goneLinks = new Set(edit.removeLinkIds)
  for (const l of [...flow.links, ...draft.links])
    if (goneBoxes.has(l.from) || goneBoxes.has(l.to)) goneLinks.add(l.id)

  const changed = { ...draft.changed }
  let boxes = draft.boxes.filter((b) => !goneBoxes.has(b.id))
  for (const u of edit.updateBoxes) {
    const { id, ...patch } = u
    if (isDraftBox(id)) boxes = boxes.map((b) => (b.id === id ? { ...b, ...patch } : b))
    else changed[id] = { ...changed[id], ...patch }
  }
  boxes = [...boxes, ...edit.addBoxes.map((b) => ({ ...b, paths: [], proposed: true as const }))]
  const removed = [
    ...new Set([
      ...(draft.removed ?? []),
      ...[...goneBoxes].filter((id) => !isDraftBox(id)),
      ...[...goneLinks].filter((id) => flow.links.some((l) => l.id === id))
    ])
  ]
  // The canvas may have changed since the agent saw it: only join boxes that still exist.
  const live = new Set([
    ...flow.boxes.filter((b) => !removed.includes(b.id)).map((b) => b.id),
    ...boxes.map((b) => b.id)
  ])
  return {
    ...draft,
    boxes,
    links: [
      ...draft.links.filter((l) => !goneLinks.has(l.id)),
      ...edit.addLinks
        .filter((l) => live.has(l.from) && live.has(l.to))
        .map((l) => newLink(l.from, l.to, l.label))
    ],
    notes: draft.notes.map((n) =>
      n.target && goneBoxes.has(n.target) && isDraftBox(n.target) ? { ...n, target: undefined } : n
    ),
    removed,
    changed
  }
}

/** The change request the agent receives: every note and proposed piece, in plain words. */
export function changeBrief(
  flow: AppFlow,
  draft: FlowDraft,
  catalog: CatalogGraph | null = null
): string {
  const boxes = new Map([...flow.boxes, ...draft.boxes].map((b) => [b.id, b]))
  const name = (id: string): string => boxes.get(id)?.name ?? id
  // Say which catalog component and files a box is, so the agent can look it up.
  const where = (id: string): string => {
    const box = boxes.get(id)
    if (!box) return ''
    const component = boxComponent(box, catalog)
    const parts = [
      component && `component ${component.componentId}`,
      box.paths.length && `files ${box.paths.join(', ')}`
    ].filter(Boolean)
    return parts.length ? ` (${parts.join('; ')})` : ''
  }
  const lines: string[] = []

  for (const n of draft.notes) {
    if (!n.text.trim()) continue
    lines.push(
      n.target
        ? `- On "${name(n.target)}"${where(n.target)}: ${n.text.trim()}`
        : `- ${n.text.trim()}`
    )
  }
  for (const id of draft.removed ?? []) {
    const link = flow.links.find((l) => l.id === id)
    if (link) lines.push(`- Remove the arrow "${name(link.from)}" → "${name(link.to)}"`)
    else lines.push(`- Remove "${name(id)}"${where(id)}`)
  }
  for (const [id, change] of Object.entries(draft.changed ?? {})) {
    const before = flow.boxes.find((b) => b.id === id)
    if (!before) continue
    const parts = [
      change.name && change.name !== before.name && `rename to "${change.name}"`,
      change.summary && change.summary !== before.summary && `now: ${change.summary}`,
      change.tables && `tables ${change.tables.join(', ')}`
    ].filter(Boolean)
    if (parts.length) lines.push(`- Change "${before.name}"${where(id)}: ${parts.join('; ')}`)
  }
  for (const b of draft.boxes) {
    const tables = b.tables.length ? ` with tables ${b.tables.join(', ')}` : ''
    const what = b.summary.trim() ? `: ${b.summary.trim()}` : ''
    lines.push(`- Add ${KIND_LABEL[b.kind].toLowerCase()} "${b.name}"${tables}${what}`)
  }
  for (const l of draft.links) {
    const label = l.label.trim() ? ` (${l.label.trim()})` : ''
    lines.push(`- Connect "${name(l.from)}" → "${name(l.to)}"${label}`)
  }
  return lines.join('\n')
}

/** The whiteboard example: a daily word game. Shown when no repo is open. */
export const EXAMPLE_FLOW: AppFlow = {
  boxes: [
    {
      id: 'game-board',
      kind: 'screen',
      name: 'Game board',
      summary: 'Six rows of guesses; the player types a five-letter word.',
      tables: [],
      paths: []
    },
    {
      id: 'word-logic',
      kind: 'logic',
      name: 'Word guess logic',
      summary: "Checks each guess against today's word and colors the letters.",
      tables: [],
      paths: []
    },
    {
      id: 'auth',
      kind: 'service',
      name: 'OAuth sign-in',
      summary: 'Signs players in with Google or GitHub.',
      tables: [],
      paths: []
    },
    {
      id: 'user-db',
      kind: 'data',
      name: 'User database',
      summary: 'Who plays, and how they did.',
      tables: ['users', 'scores', 'streaks'],
      paths: []
    },
    {
      id: 'word-list',
      kind: 'data',
      name: 'Word list',
      summary: "Every playable word and each day's answer.",
      tables: ['words'],
      paths: []
    }
  ],
  links: [
    { id: 'game-board->auth', from: 'game-board', to: 'auth', label: 'signs in' },
    { id: 'game-board->word-logic', from: 'game-board', to: 'word-logic', label: 'submits guess' },
    { id: 'word-logic->word-list', from: 'word-logic', to: 'word-list', label: "today's word" },
    { id: 'word-logic->user-db', from: 'word-logic', to: 'user-db', label: 'saves score' },
    { id: 'auth->user-db', from: 'auth', to: 'user-db', label: 'creates user' }
  ]
}

export const EXAMPLE_DRAFT: FlowDraft = {
  ...emptyFlowDraft,
  notes: [{ id: 'note-supabase', text: 'I want this on Supabase', target: 'user-db' }]
}
