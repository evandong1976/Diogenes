import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesignApproval } from '../../../shared/backend'
import type { DraftState, Proposal, ProjectState, WhiteboardSnapshot } from '../../../shared/design'
import type { ThreadEvent, ThreadSummary } from '../../../shared/threads'
import type { ApprovalRecord } from '../../../shared/workflow'
import { runningTurn, turnInput, type SelectionCheck } from './chat'

/** Where the project's design backend stands. Every state is shown as-is in the chat pane. */
export type ProjectLoad =
  | { status: 'off' }
  /** The design draft starts from the indexed catalog, so it waits for a snapshot. */
  | { status: 'waiting'; message: string }
  | { status: 'loading' }
  /** The backend refused or could not open storage; `message` is its reason. */
  | { status: 'unavailable'; message: string }
  | { status: 'ready' }

/** Result of the last approve in this window, by proposal ID. */
export type ApprovalOutcome =
  | { kind: 'frozen'; approvalId: string; revision: number }
  /** Approved on the draft, but no coding handoff could be frozen from it. */
  | { kind: 'draft-only'; revision: number; message: string }
  /** Not approved: the backend's code and message (e.g. `stale`). */
  | { kind: 'refused'; code: string; message: string; currentRevision?: number }

export interface PendingSend {
  threadId: string
  text: string
  model: string
  selection: SelectionCheck
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const sortThreads = (list: ThreadSummary[]): ThreadSummary[] =>
  [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
const WAITING = 'The design draft opens from the indexed catalog. Waiting for indexing to finish.'
const POLL_MS = 1500

export interface DesignChat {
  load: ProjectLoad
  project: ProjectState | null
  draft: DraftState | null
  threads: ThreadSummary[]
  activeId: string | null
  events: ThreadEvent[]
  pending: PendingSend | null
  /** Messages sent here, by turn ID, so turns that never reached history still read. */
  sent: Record<string, string>
  error: string | null
  approvals: Record<string, ApprovalOutcome>
  /** Frozen approvals from the workflow, so a reopened project still shows them. */
  frozen: ApprovalRecord[]
  deciding: string | null
  reload(): void
  openThread(id: string): void
  newThread(): Promise<void>
  send(
    text: string,
    model: string,
    selection: SelectionCheck,
    whiteboard?: WhiteboardSnapshot | null
  ): Promise<boolean>
  cancel(): void
  approve(proposal: Proposal): Promise<void>
  discard(proposal: Proposal): Promise<void>
  dismissError(): void
}

/**
 * Project-scoped design chat over `window.api.backend`: threads, the working draft, turns and
 * proposals. Durable state stays in the backend; this holds what the pane is looking at.
 */
export function useDesignChat(projectId: string | null, indexedSha: string | null): DesignChat {
  const api = window.api.backend
  const [opened, setOpened] = useState<ProjectLoad>({ status: 'loading' })
  const [project, setProject] = useState<ProjectState | null>(null)
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [events, setEvents] = useState<ThreadEvent[]>([])
  const [pending, setPending] = useState<PendingSend | null>(null)
  const [sent, setSent] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [approvals, setApprovals] = useState<Record<string, ApprovalOutcome>>({})
  const [frozen, setFrozen] = useState<ApprovalRecord[]>([])
  const [deciding, setDeciding] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // Drops results that arrive after the project or thread changed.
  const scope = useRef({ projectId, activeId })
  useEffect(() => {
    scope.current = { projectId, activeId }
  }, [projectId, activeId])

  // A different project or snapshot starts from nothing (reset while rendering, not in an effect).
  const projectKey = projectId && indexedSha ? `${projectId}@${indexedSha}#${attempt}` : null
  const [shownProject, setShownProject] = useState(projectKey)
  if (shownProject !== projectKey) {
    setShownProject(projectKey)
    setOpened({ status: 'loading' })
    setProject(null)
    setThreads([])
    setActiveId(null)
    setPending(null)
    setSent({})
    setError(null)
    setApprovals({})
    setFrozen([])
  }
  // Switching threads clears the old transcript until the new one loads.
  const threadKey = projectId && activeId ? `${projectId}/${activeId}` : null
  const [shownThread, setShownThread] = useState(threadKey)
  if (shownThread !== threadKey) {
    setShownThread(threadKey)
    setEvents([])
  }

  const load: ProjectLoad = !projectId
    ? { status: 'off' }
    : !indexedSha
      ? { status: 'waiting', message: WAITING }
      : opened

  const refreshWorkflow = useCallback(
    (p: string) =>
      api.workflow.getProject(p).then(
        (w) => scope.current.projectId === p && setFrozen(w.approvals),
        // Approvals are extra context here; the design chat works without them.
        () => {}
      ),
    [api]
  )

  // Open the draft and list threads once the repo has an indexed snapshot.
  useEffect(() => {
    if (!projectId || !indexedSha) return
    let live = true
    Promise.all([
      api.design.openProject(projectId),
      api.threads.list(projectId, { kind: 'design' })
    ])
      .then(([state, list]) => {
        if (!live) return
        const sorted = sortThreads(list)
        setProject(state)
        setThreads(sorted)
        setActiveId(sorted[0]?.id ?? null)
        setOpened({ status: 'ready' })
        void refreshWorkflow(projectId)
      })
      .catch((e) => live && setOpened({ status: 'unavailable', message: message(e) }))
    return () => {
      live = false
    }
  }, [api, projectId, indexedSha, attempt, refreshWorkflow])

  // Load the open thread's transcript.
  useEffect(() => {
    if (!projectId || !activeId) return
    let live = true
    api.threads.open(projectId, activeId).then(
      (snapshot) => live && setEvents(snapshot.events),
      (e) => live && setError(message(e))
    )
    return () => {
      live = false
    }
  }, [api, projectId, activeId])

  const refresh = useCallback(async (): Promise<void> => {
    const { projectId: p, activeId: t } = scope.current
    if (!p) return
    const [state, list] = await Promise.all([
      api.design.getProject(p),
      api.threads.list(p, { kind: 'design' })
    ])
    if (scope.current.projectId !== p) return
    setProject(state)
    setThreads(sortThreads(list))
    if (t) {
      const snapshot = await api.threads.open(p, t)
      if (scope.current.activeId === t) setEvents(snapshot.events)
    }
  }, [api])

  // While a turn runs, poll so tool activity and the developer message appear as they land.
  const sending = !!pending
  useEffect(() => {
    if (!sending) return
    const timer = setInterval(() => void refresh().catch(() => {}), POLL_MS)
    return () => clearInterval(timer)
  }, [sending, refresh])

  const guard = async (task: () => Promise<void>): Promise<void> => {
    setError(null)
    try {
      await task()
    } catch (e) {
      setError(message(e))
    }
  }

  const createThread = async (p: string): Promise<ThreadSummary> => {
    const stamp = new Date().toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
    const thread = await api.threads.create(p, { kind: 'design', title: `Design · ${stamp}` })
    setThreads((list) => sortThreads([thread, ...list.filter((t) => t.id !== thread.id)]))
    setActiveId(thread.id)
    return thread
  }

  const draft = project?.draft ?? null

  return {
    load,
    project,
    draft,
    threads,
    activeId,
    events,
    pending,
    sent,
    error,
    approvals,
    frozen,
    deciding,
    reload: () => setAttempt((n) => n + 1),
    openThread: (id) => {
      setError(null)
      setActiveId(id)
    },
    newThread: () =>
      guard(async () => {
        if (projectId) await createThread(projectId)
      }),
    send: async (text, model, selection, whiteboard) => {
      if (!projectId || !draft || pending || !text.trim()) return false
      setError(null)
      let threadId = activeId
      try {
        threadId ??= (await createThread(projectId)).id
      } catch (e) {
        setError(message(e))
        return false
      }
      setPending({ threadId, text: text.trim(), model, selection })
      try {
        const result = await api.design.startTurn(
          turnInput({ projectId, threadId, model, draft, message: text, selection, whiteboard })
        )
        setSent((s) => ({ ...s, [result.turn.id]: text.trim() }))
        if (result.correctionError) setError(`Correction not forwarded: ${result.correctionError}`)
        return true
      } catch (e) {
        setError(message(e))
        // The message stays in the composer so nothing typed is lost.
        return false
      } finally {
        setPending(null)
        await refresh().catch((e) => setError(message(e)))
      }
    },
    cancel: () => {
      const turn = activeId ? runningTurn(project, activeId) : null
      if (projectId && turn)
        void guard(async () => void (await api.design.cancelTurn(projectId, turn.id)))
    },
    approve: (proposal) =>
      guard(async () => {
        if (!projectId || !draft) return
        setDeciding(proposal.id)
        try {
          const result: DesignApproval = await api.design.approve(
            projectId,
            proposal.id,
            draft.revision
          )
          const d = result.design
          setApprovals((a) => ({
            ...a,
            [proposal.id]: !d.ok
              ? {
                  kind: 'refused',
                  code: d.code,
                  message: d.issue ? `${d.message} ${d.issue.message}` : d.message,
                  currentRevision: d.currentRevision
                }
              : result.approval
                ? {
                    kind: 'frozen',
                    approvalId: result.approval.approvalId,
                    revision: d.draft.revision
                  }
                : {
                    kind: 'draft-only',
                    revision: d.draft.revision,
                    message: result.approvalError ?? 'No coding handoff was frozen.'
                  }
          }))
          await refresh()
          await refreshWorkflow(projectId)
        } finally {
          setDeciding(null)
        }
      }),
    discard: (proposal) =>
      guard(async () => {
        if (!projectId) return
        setDeciding(proposal.id)
        try {
          await api.design.reject(projectId, proposal.id, 'Discarded from the design chat.')
          await refresh()
        } finally {
          setDeciding(null)
        }
      }),
    dismissError: () => setError(null)
  }
}
