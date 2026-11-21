// Building an accepted whiteboard edit in the codebase: the backend freezes the edit with the
// source of the boxes it touches and starts a managed coding run; this follows that run.
import type { HandoffRecord } from '../../../shared/workflow'

export interface WhiteboardBuild {
  projectId: string
  turnId: string
  /** What was sent: the editable scope and how many source files went with it. */
  sent?: { scope: string[]; files: number }
  handoff?: HandoffRecord
  error?: string
}

const POLL_MS = 4_000
/** Stages where the run or the local check is still working. */
const working = (h: HandoffRecord): boolean => h.stage === 'coding' || h.stage === 'verifying'

/**
 * Sends the accepted edit from `turnId` to a coding run, then advances the handoff until it
 * settles. `update` receives every state; the loop stops once the build is replaced or dismissed.
 */
export async function startBuild(
  projectId: string,
  turnId: string,
  update: (next: (b: WhiteboardBuild | null) => WhiteboardBuild | null) => void
): Promise<void> {
  const mine = (b: WhiteboardBuild | null): boolean => b?.turnId === turnId
  let alive = true
  // Once the card is dismissed or replaced by a newer build, stop following this one.
  const set = (patch: Partial<WhiteboardBuild>): void =>
    update((b) => {
      if (!b || !mine(b)) {
        alive = false
        return b
      }
      return { ...b, ...patch }
    })
  update(() => ({ projectId, turnId }))
  const api = window.api.backend.workflow
  // The renderer hot-reloads in `pnpm dev`, but the preload bridge and main process don't.
  if (typeof api.buildWhiteboard !== 'function') {
    set({
      error: 'This window is running an older Diogenes backend. Restart the app, then accept again.'
    })
    return
  }
  try {
    const { approval, handoff } = await api.buildWhiteboard(projectId, turnId)
    const packet = approval.packet
    set({
      handoff,
      sent: {
        scope: packet.kind === 'whiteboard' ? packet.scope : [],
        files: packet.sourceContext?.length ?? 0
      }
    })
    let current = handoff
    while (alive && working(current)) {
      await new Promise((r) => setTimeout(r, POLL_MS))
      if (!alive) break
      current = await api.refresh(projectId, current.handoffId)
      set({ handoff: current })
    }
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) })
  }
}

/** One line for where the build stands. */
export function buildStatus(build: WhiteboardBuild): {
  tone: 'run' | 'ok' | 'warn' | 'error'
  text: string
} {
  if (build.error) return { tone: 'error', text: build.error }
  const h = build.handoff
  if (!h) return { tone: 'run', text: 'Freezing the change and the files it needs…' }
  const run = h.runs.at(-1)
  const files = run?.candidate ? run.candidate.files.length + run.candidate.deleted.length : 0
  switch (h.stage) {
    case 'coding': {
      const last = run?.run.events.at(-1)?.text
      return {
        tone: 'run',
        text: `Coding agent ${run?.run.status ?? 'queued'}${last ? ` · ${last}` : ''}`
      }
    }
    case 'verifying':
      return { tone: 'run', text: `Checking the candidate (${files} files changed)…` }
    case 'accepted':
      return { tone: 'ok', text: `Built and type checked · ${files} files changed` }
    case 'correctable':
      return {
        tone: 'warn',
        text: `The candidate failed a check (${run?.verdict?.obligations
          .filter((o) => o.outcome === 'fail')
          .map((o) => o.id)
          .join(', ')}). Ask the chat to correct it.`
      }
    case 'needs-decision':
      return { tone: 'warn', text: h.decision?.detail ?? 'The run needs a decision in the chat.' }
    case 'closed':
      return { tone: 'warn', text: 'Closed.' }
  }
}
