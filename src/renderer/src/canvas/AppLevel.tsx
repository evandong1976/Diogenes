import { useEffect, useRef, useState } from 'react'
import type { GithubRepo } from '../../../preload'
import type { AppFlow } from '../../../shared/gemini'
import type { IndexStatus } from '../../../shared/indexing'
import { AppCanvas } from './AppCanvas'
import { PaneToggle } from './PaneToggle'
import { EXAMPLE_FLOW, type Box, type FlowDraft } from './flow'
import { indexRunning } from './indexStatus'

interface Props {
  /** Null in example mode: the whiteboard word game is shown. */
  repo: GithubRepo | null
  flow: AppFlow | null
  onFlow(flow: AppFlow): void
  draft: FlowDraft
  setDraft(update: (d: FlowDraft) => FlowDraft): void
  indexStatus: IndexStatus | null
  focusFile: string | null
  onOpenLogic(box: Box): void
}

/** The one canvas: how the app runs, and what the engineer wants changed. */
export function AppLevel({
  repo,
  flow,
  onFlow,
  draft,
  setDraft,
  indexStatus,
  focusFile,
  onOpenLogic
}: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const waiting = indexRunning(indexStatus)
  const asked = useRef<number | null>(null)
  // The repo whose saved map we looked for and didn't find; only then is Gemini called on its own.
  const [noSaved, setNoSaved] = useState<number | null>(null)

  const infer = async (): Promise<void> => {
    if (!repo) return
    setBusy(true)
    setError(null)
    try {
      onFlow(
        await window.api.gemini.buildAppFlow({
          id: repo.id,
          fullName: repo.fullName,
          branch: repo.defaultBranch
        })
      )
      setVersion((v) => v + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // A repo opened before shows its saved map at once, without waiting for indexing or Gemini.
  const repoId = repo?.id
  useEffect(() => {
    if (repoId === undefined || flow) return
    let active = true
    void window.api.gemini.loadAppFlow(repoId).then((saved) => {
      if (!active) return
      if (saved) onFlow(saved)
      else setNoSaved(repoId)
    })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per repo
  }, [repoId])

  // First open only: read the repo after indexing settles, so Gemini sees the index too. The
  // result is saved; after that it is redrawn only on Re-read.
  useEffect(() => {
    if (!repo || flow || waiting || noSaved !== repo.id || asked.current === repo.id) return
    asked.current = repo.id
    void infer()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `infer` only reads these
  }, [repo, flow, waiting, noSaved])

  const shown = repo ? flow : EXAMPLE_FLOW
  // Still looking on disk: no "Read repo" button yet, or a click would redo a saved map.
  const checking = !!repo && !flow && noSaved !== repo.id
  const status = (
    <>
      <span className="dg-label">
        {!repo
          ? 'Example · daily word game'
          : busy
            ? 'Reading the repo…'
            : flow
              ? `${flow.boxes.length} boxes`
              : 'No map yet'}
      </span>
      {repo && !busy && !waiting && (
        <button className="dg-btn dg-btn--ghost" onClick={() => void infer()}>
          {flow ? 'Re-read' : 'Read repo'}
        </button>
      )}
    </>
  )

  return (
    <div className="level">
      {error && <p className="notice error">{error}</p>}
      {shown ? (
        <AppCanvas
          flow={shown}
          draft={draft}
          setDraft={setDraft}
          viewKey={`${repo?.id ?? 'example'}-${version}`}
          focusFile={focusFile}
          onOpenLogic={onOpenLogic}
          status={status}
        />
      ) : (
        <div className="dg-canvas--dots canvas-empty level-empty">
          <div className="level-empty__panes">
            <PaneToggle side="left" />
          </div>
          <span className="dg-label">
            {checking
              ? `Opening ${repo?.fullName}…`
              : busy || waiting
                ? `Reading ${repo?.fullName}…`
                : 'No map yet.'}
          </span>
          {!busy && !waiting && !checking && (
            <button className="dg-btn" onClick={() => void infer()}>
              Read repo
            </button>
          )}
        </div>
      )}
    </div>
  )
}
