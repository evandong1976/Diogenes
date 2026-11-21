import { flowKinds, type FlowKind } from '../../shared/gemini'
import type { WhiteboardEdit, WhiteboardSnapshot } from '../../shared/design'
import { isSafeRepoPath } from '../gemini/contracts'

// Checks for the whiteboard: the snapshot the renderer sends with a turn (untrusted, from IPC) and
// the edits the agent proposes against it (untrusted, from the model). Electron-free and pure.

const LIMITS = { boxes: 80, links: 200, notes: 50, paths: 12, tables: 30, text: 500, note: 2_000 }
const EDIT_LIMITS = { boxes: 12, links: 24 }
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/i

export class WhiteboardError extends Error {}

const str = (v: unknown, max = LIMITS.text): string =>
  typeof v === 'string' ? v.slice(0, max) : ''
const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : []
const isKind = (v: unknown): v is FlowKind => flowKinds.includes(v as FlowKind)

/** A clean copy of the renderer's whiteboard, or undefined when none was sent. Never throws. */
export function sanitizeWhiteboard(value: unknown): WhiteboardSnapshot | undefined {
  const raw = value as Partial<Record<keyof WhiteboardSnapshot, unknown>> | null
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.boxes)) return undefined
  const boxes = (raw.boxes as Record<string, unknown>[])
    .filter((b) => b && typeof b.id === 'string' && isKind(b.kind))
    .slice(0, LIMITS.boxes)
    .map((b) => ({
      id: str(b.id, 80),
      kind: b.kind as FlowKind,
      name: str(b.name) || str(b.id, 80),
      summary: str(b.summary),
      tables: strings(b.tables, LIMITS.tables).map((t) => t.slice(0, 120)),
      paths: strings(b.paths, LIMITS.paths).filter(isSafeRepoPath),
      ...(b.proposed === true && { proposed: true })
    }))
  const ids = new Set(boxes.map((b) => b.id))
  const links = (Array.isArray(raw.links) ? (raw.links as Record<string, unknown>[]) : [])
    .filter((l) => l && typeof l.id === 'string' && ids.has(l.from as string) && ids.has(l.to as string))
    .slice(0, LIMITS.links)
    .map((l) => ({ id: str(l.id, 80), from: l.from as string, to: l.to as string, label: str(l.label, 120) }))
  const notes = (Array.isArray(raw.notes) ? (raw.notes as Record<string, unknown>[]) : [])
    .filter((n) => n && typeof n.text === 'string' && n.text.trim())
    .slice(0, LIMITS.notes)
    .map((n) => ({
      text: str(n.text, LIMITS.note),
      ...(typeof n.target === 'string' && ids.has(n.target) && { target: n.target })
    }))
  return { boxes, links, notes }
}

/** The agent's proposed edit, checked against the whiteboard it was given. Throws on any problem. */
export function validateWhiteboardEdit(
  args: Record<string, unknown>,
  board: WhiteboardSnapshot
): WhiteboardEdit {
  const fail = (message: string): never => {
    throw new WhiteboardError(message)
  }
  const list = (key: string): Record<string, unknown>[] => {
    const v = args[key] ?? []
    if (!Array.isArray(v)) fail(`${key} must be an array.`)
    return v as Record<string, unknown>[]
  }
  const summary = str(args.summary).trim()
  if (!summary) fail('summary is required.')

  const boxIds = new Set(board.boxes.map((b) => b.id))
  const linkIds = new Set(board.links.map((l) => l.id))

  const removeBoxIds = strings(args.removeBoxIds ?? [], EDIT_LIMITS.boxes)
  for (const id of removeBoxIds) if (!boxIds.has(id)) fail(`No box ${id} on the whiteboard.`)
  const removeLinkIds = strings(args.removeLinkIds ?? [], EDIT_LIMITS.links)
  for (const id of removeLinkIds) if (!linkIds.has(id)) fail(`No arrow ${id} on the whiteboard.`)

  const addBoxes = list('addBoxes').map((b) => {
    const id = str(b.id, 64)
    if (!ID.test(id)) fail(`New box ID "${id}" must be short kebab-case.`)
    if (boxIds.has(id)) fail(`Box ${id} already exists; use updateBoxes or a new ID.`)
    if (!isKind(b.kind)) fail(`Box ${id} kind must be one of ${flowKinds.join(', ')}.`)
    const name = str(b.name).trim()
    if (!name) fail(`Box ${id} needs a name.`)
    return {
      id,
      kind: b.kind as FlowKind,
      name,
      summary: str(b.summary).trim(),
      tables: strings(b.tables, LIMITS.tables)
    }
  })
  const added = new Set(addBoxes.map((b) => b.id))
  if (added.size !== addBoxes.length) fail('New box IDs must be unique.')
  if (addBoxes.length > EDIT_LIMITS.boxes) fail(`At most ${EDIT_LIMITS.boxes} new boxes.`)

  const updateBoxes = list('updateBoxes').map((u) => {
    const id = str(u.id, 80)
    if (!boxIds.has(id)) fail(`No box ${id} to update.`)
    if (removeBoxIds.includes(id)) fail(`Box ${id} is both updated and removed.`)
    const patch: WhiteboardEdit['updateBoxes'][number] = { id }
    if (typeof u.name === 'string' && u.name.trim()) patch.name = str(u.name).trim()
    if (typeof u.summary === 'string') patch.summary = str(u.summary).trim()
    if (Array.isArray(u.tables)) patch.tables = strings(u.tables, LIMITS.tables)
    if (Object.keys(patch).length === 1) fail(`Update to ${id} changes nothing.`)
    return patch
  })

  // Arrows may join existing boxes that stay, and boxes this edit adds.
  const endpoints = new Set([...[...boxIds].filter((id) => !removeBoxIds.includes(id)), ...added])
  const addLinks = list('addLinks').map((l) => {
    const from = str(l.from, 80)
    const to = str(l.to, 80)
    if (!endpoints.has(from) || !endpoints.has(to))
      fail(`Arrow ${from} → ${to} must join boxes that exist after the edit.`)
    if (from === to) fail('An arrow needs two different boxes.')
    return { from, to, label: str(l.label, 120).trim() }
  })
  if (addLinks.length > EDIT_LIMITS.links) fail(`At most ${EDIT_LIMITS.links} new arrows.`)

  if (
    !addBoxes.length &&
    !updateBoxes.length &&
    !removeBoxIds.length &&
    !addLinks.length &&
    !removeLinkIds.length
  )
    fail('The edit changes nothing.')

  return { summary, addBoxes, updateBoxes, removeBoxIds, addLinks, removeLinkIds }
}

/** The whiteboard as compact text for the model's context. */
export function describeWhiteboard(board: WhiteboardSnapshot): string {
  return JSON.stringify({
    boxes: board.boxes.map(({ id, kind, name, summary, tables, paths, proposed }) => ({
      id,
      kind,
      name,
      ...(summary && { summary }),
      ...(tables.length && { tables }),
      ...(paths.length && { files: paths }),
      ...(proposed && { proposed })
    })),
    arrows: board.links.map(({ id, from, to, label }) => ({ id, from, to, ...(label && { label }) })),
    notes: board.notes
  })
}
