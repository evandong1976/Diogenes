/**
 * Freezes a whiteboard edit the developer accepted into the packet a coding run and the local
 * verifier read. The packet carries what to change (the edit, as plain required changes), why
 * (the developer's notes), where (the files of the boxes it touches, plus the root manifest so a
 * new dependency can be added) and that code at the base commit.
 *
 * There is no catalog patch to re-index against, so the only local obligation is the type check.
 */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { loadTypescript } from '../indexing/scip.ts'
import { ApprovalError, git, type FrozenApproval } from './approval.ts'
import { contextFor } from './catalogApproval.ts'
import type { WhiteboardEdit, WhiteboardSnapshot } from '../../shared/design'
import type { WhiteboardApprovalRequest, WhiteboardApprovedChange } from '../../shared/workflow'

export const WHITEBOARD_VERIFIER_ID = 'diogenes-whiteboard-v1'

/** Manifests a change may need to touch, such as adding a client library. Kept if present. */
const MANIFESTS = ['package.json']

export function freezeWhiteboard(
  repoDir: string,
  request: WhiteboardApprovalRequest
): FrozenApproval {
  const { baseCommit: base, edit, whiteboard, correlation, repository } = request
  if (String(repository.id) !== correlation.projectId)
    throw new ApprovalError(
      `Edit is for project ${correlation.projectId}, repository is ${repository.id}`
    )
  if (!/^[0-9a-f]{40}$/.test(base))
    throw new ApprovalError(`Base commit ${base} is not a full commit SHA`)
  if (git(repoDir, ['rev-parse', '--verify', `${base}^{commit}`]).trim() !== base)
    throw new ApprovalError(`Base ${base} is not a full commit SHA in ${repoDir}`)

  const touched = touchedBoxes(edit, whiteboard)
  const scope = scopeOf(repoDir, base, touched, whiteboard)
  if (!scope.length)
    throw new ApprovalError(
      'None of the boxes this change touches cite files, so there is nowhere in the code to make it.'
    )
  const sourceContext = contextFor(repoDir, base, scope)
  const name = boxNamer(edit, whiteboard)

  const packet: WhiteboardApprovedChange = {
    version: 1,
    kind: 'whiteboard',
    repository,
    baseCommit: base,
    targetComponentId: touched[0] ?? edit.addBoxes[0]?.id ?? 'whiteboard',
    edit,
    whiteboard,
    scope,
    obligations: [
      {
        id: 'native-typecheck',
        scope:
          'The TypeScript compiler reports no diagnostic for the candidate that the base commit does not already have. Dependencies are not installed; compilation only, not behavior.'
      }
    ],
    requiredChanges: [
      edit.summary,
      ...requiredChanges(edit, whiteboard, name),
      ...notesAbout(touched, whiteboard, name)
    ],
    preserved: [
      'boxes and arrows this change does not mention keep working as they do',
      'exports used by code outside the editable scope keep their names and signatures'
    ],
    openChoices: [
      'how the change is implemented within the editable scope',
      'library versions, file layout and helper names'
    ],
    toolchain: { verifier: WHITEBOARD_VERIFIER_ID, typescript: loadTypescript().version },
    correlation,
    sourceContext
  }
  const bytes = `${JSON.stringify(packet, null, 2)}\n`
  return { approvalId: createHash('sha256').update(bytes).digest('hex'), packet, bytes }
}

/** Existing boxes the edit changes, removes or connects, in a stable order. */
function touchedBoxes(edit: WhiteboardEdit, board: WhiteboardSnapshot): string[] {
  const existing = new Set(board.boxes.map((b) => b.id))
  const removedLinks = board.links.filter((l) => edit.removeLinkIds.includes(l.id))
  const ids = [
    ...edit.removeBoxIds,
    ...edit.updateBoxes.map((u) => u.id),
    ...edit.addLinks.flatMap((l) => [l.from, l.to]),
    ...removedLinks.flatMap((l) => [l.from, l.to])
  ]
  return [...new Set(ids.filter((id) => existing.has(id)))]
}

/**
 * Where the candidate may write: the directories holding the touched boxes' files (so new files
 * can sit beside them), plus root manifests that exist at the base commit.
 */
function scopeOf(
  repoDir: string,
  base: string,
  touched: string[],
  board: WhiteboardSnapshot
): string[] {
  const paths = board.boxes
    .filter((b) => touched.includes(b.id))
    .flatMap((b) => b.paths)
    .filter(isRepoPath)
  if (!paths.length) return []
  const entries = new Set<string>()
  for (const p of paths) {
    const type = objectType(repoDir, base, p)
    if (type === 'tree') entries.add(p)
    else if (type === 'blob') entries.add(posix.dirname(p) === '.' ? p : posix.dirname(p))
  }
  for (const m of MANIFESTS) if (objectType(repoDir, base, m) === 'blob') entries.add(m)
  const sorted = [...entries].sort()
  return sorted.filter((e) => !sorted.some((o) => o !== e && e.startsWith(`${o}/`)))
}

function objectType(repoDir: string, base: string, path: string): string | null {
  try {
    return git(repoDir, ['cat-file', '-t', `${base}:${path}`]).trim()
  } catch {
    return null
  }
}

const isRepoPath = (p: string): boolean =>
  !!p && !posix.isAbsolute(p) && posix.normalize(p) === p && !p.split('/').includes('..')

function boxNamer(edit: WhiteboardEdit, board: WhiteboardSnapshot): (id: string) => string {
  const names = new Map([
    ...board.boxes.map((b) => [b.id, b.name] as const),
    ...edit.addBoxes.map((b) => [b.id, b.name] as const)
  ])
  return (id) => names.get(id) ?? id
}

/** The edit as plain instructions a coding agent can act on, naming the code behind each box. */
function requiredChanges(
  edit: WhiteboardEdit,
  board: WhiteboardSnapshot,
  name: (id: string) => string
): string[] {
  const files = (id: string): string => {
    const paths = board.boxes.find((b) => b.id === id)?.paths ?? []
    return paths.length ? ` (code: ${paths.join(', ')})` : ''
  }
  const lines: string[] = []
  for (const id of edit.removeBoxIds)
    lines.push(`Remove "${name(id)}"${files(id)} and move its callers to what replaces it`)
  for (const b of edit.addBoxes) {
    const tables = b.tables.length ? ` with ${b.tables.join(', ')}` : ''
    lines.push(`Add ${b.kind} "${b.name}"${tables}${b.summary ? `: ${b.summary}` : ''}`)
  }
  for (const u of edit.updateBoxes) {
    const parts = [
      u.name && `rename to "${u.name}"`,
      u.summary && `it now: ${u.summary}`,
      u.tables && `tables ${u.tables.join(', ')}`
    ].filter(Boolean)
    lines.push(`Change "${name(u.id)}"${files(u.id)}: ${parts.join('; ')}`)
  }
  for (const id of edit.removeLinkIds) {
    const l = board.links.find((x) => x.id === id)
    if (l) lines.push(`"${name(l.from)}" no longer uses "${name(l.to)}"`)
  }
  for (const l of edit.addLinks)
    lines.push(`"${name(l.from)}" uses "${name(l.to)}"${l.label ? ` (${l.label})` : ''}`)
  return lines
}

/** The developer's own words about the boxes involved. */
function notesAbout(
  touched: string[],
  board: WhiteboardSnapshot,
  name: (id: string) => string
): string[] {
  return board.notes
    .filter((n) => !n.target || touched.includes(n.target))
    .map((n) =>
      n.target ? `Developer note on "${name(n.target)}": ${n.text}` : `Developer note: ${n.text}`
    )
}
