// The app canvas model: Gemini's map of how the app runs, plus what the engineer proposes on top
// (new boxes, new arrows, sticky-note instructions). Pure data, so the brief can be tested.
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

export interface FlowDraft {
  boxes: Box[]
  links: Link[]
  notes: Note[]
  positions: Record<string, Point>
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

export const newLink = (from: string, to: string): Link => ({
  id: newId('link'),
  from,
  to,
  label: '',
  proposed: true
})

/** The change request the agent receives: every note and proposed piece, in plain words. */
export function changeBrief(flow: AppFlow, draft: FlowDraft): string {
  const boxes = new Map([...flow.boxes, ...draft.boxes].map((b) => [b.id, b]))
  const name = (id: string): string => boxes.get(id)?.name ?? id
  const lines: string[] = []

  for (const n of draft.notes) {
    if (!n.text.trim()) continue
    lines.push(n.target ? `- On "${name(n.target)}": ${n.text.trim()}` : `- ${n.text.trim()}`)
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
