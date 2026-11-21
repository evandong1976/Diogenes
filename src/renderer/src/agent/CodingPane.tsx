import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  CandidateDiff,
  HandoffRecord,
  RunRecord,
  SubmittedBrief
} from '../../../shared/workflow'
import { DESIGN_MODELS } from './chat'
import {
  ORIGIN_LABEL,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  attemptEvents,
  canFollowUp,
  codingEntries,
  codingSteps,
  failureEvidence,
  localLine,
  providerLine,
  replySummary,
  selectEntry,
  traceRows
} from './coding'
import { Markdown } from './Markdown'
import { Picker } from './Picker'
import type { DesignChat } from './useDesignChat'

interface Props {
  chat: DesignChat
  /** The approval to show; null shows the most recently active one. */
  focus: string | null
  onFocus(approvalId: string): void
  /** Hidden panes stay mounted, so the selection, draft and scroll survive a tab swap. */
  hidden?: boolean
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The Coding tab, as a conversation with the coding agent: each attempt's brief is the message
 * it received (the exact Markdown), and the agent's shell activity, what it said, and what the
 * local checks found are its reply. Follow-ups continue in the same workspace.
 */
export function CodingPane({ chat, focus, onFocus, hidden }: Props): React.JSX.Element {
  const api = window.api.backend.workflow
  const projectId = chat.project?.projectId ?? null
  const entries = useMemo(
    () => codingEntries(chat.frozen, chat.handoffs),
    [chat.frozen, chat.handoffs]
  )
  const entry = selectEntry(entries, focus)
  const handoff = entry?.handoff ?? null
  const approvalId = entry?.approvalId ?? null
  const [text, setText] = useState('')
  const logRef = useRef<HTMLOListElement>(null)
  const pinned = useRef(true)
  const scrolled = useRef(0)

  // Briefs are read back from what each attempt submitted; before a start, from the packet.
  const [briefs, setBriefs] = useState<{ key: string; list: SubmittedBrief[] } | null>(null)
  const [preview, setPreview] = useState<{ key: string; text: string } | null>(null)
  const briefKey = handoff ? `${handoff.handoffId}:${handoff.runs.length}` : null
  const handoffId = handoff?.handoffId
  useEffect(() => {
    if (!projectId || !handoffId || !briefKey) return
    let live = true
    api.briefs(projectId, handoffId).then(
      (list) => live && setBriefs({ key: briefKey, list }),
      () => {}
    )
    return () => {
      live = false
    }
  }, [api, projectId, handoffId, briefKey])
  useEffect(() => {
    if (!projectId || !approvalId || handoffId) return
    let live = true
    api.briefPreview(projectId, approvalId).then(
      (t) => live && setPreview({ key: approvalId, text: t }),
      () => {}
    )
    return () => {
      live = false
    }
  }, [api, projectId, approvalId, handoffId])

  // Reopening the tab puts the transcript back where it was; new activity follows the bottom.
  useLayoutEffect(() => {
    const log = logRef.current
    if (hidden || !log) return
    log.scrollTop = pinned.current ? log.scrollHeight : scrolled.current
  }, [hidden])
  const activity = handoff?.runs.at(-1)?.run.events.length ?? 0
  useEffect(() => {
    const log = logRef.current
    if (hidden || !log || !pinned.current) return
    log.scrollTop = log.scrollHeight
  }, [hidden, approvalId, activity, handoff?.runs.length, handoff?.stage, briefs])
  useEffect(() => {
    pinned.current = true
  }, [approvalId])
  const onScroll = (): void => {
    const log = logRef.current
    if (hidden || !log) return
    scrolled.current = log.scrollTop
    pinned.current = log.scrollHeight - log.scrollTop - log.clientHeight < 32
  }

  const panel = {
    className: 'chat coding',
    id: 'panel-coding',
    role: 'tabpanel',
    'aria-labelledby': 'tab-coding',
    hidden
  } as const
  if (!entry)
    return (
      <section {...panel}>
        <p className="chat__state">
          Approve a proposed change in Chat, then send it to the coding agent. Its run opens here.
        </p>
      </section>
    )

  const running = handoff?.stage === 'coding' || handoff?.stage === 'verifying'
  const steps = codingSteps(handoff)
  const status = steps.find((step) => step.state === 'current') ?? steps.at(-1)
  const followUp = canFollowUp(handoff)
  const busy = !!chat.codingBusy
  const canSend = followUp && !busy && !!text.trim()
  const send = async (): Promise<void> => {
    if (!canSend || !handoff) return
    pinned.current = true
    if (await chat.steerHandoff(handoff, text)) setText('')
  }
  const briefFor = (r: RunRecord): SubmittedBrief | undefined =>
    briefs?.key === briefKey ? briefs.list.find((b) => b.attempt === r.attempt) : undefined

  return (
    <section {...panel}>
      <div className="chat__threads">
        <Picker
          className="chat__thread-picker"
          label="Approved change"
          value={entry.approvalId}
          options={entries.map((e) => ({
            value: e.approvalId,
            label: e.label,
            hint: e.handoff?.stage ?? 'not sent'
          }))}
          onChange={onFocus}
        />
        {status && handoff && (
          <span
            className="coding__status dg-label"
            role="status"
            data-tone={
              status.state === 'failed' ? 'danger' : status.state === 'done' ? 'ok' : 'info'
            }
          >
            {handoff.stage === 'coding' ? 'Working' : status.label}
          </span>
        )}
      </div>

      <ol className="chat__log" ref={logRef} onScroll={onScroll} aria-live="polite">
        {!handoff ? (
          <li className="chat__turn">
            <BriefMessage
              label="Handoff · not sent yet"
              summary={entry.label}
              markdown={preview?.key === entry.approvalId ? preview.text : null}
            />
            <div className="chat__actions">
              <button
                type="button"
                className="dg-btn dg-btn--primary"
                disabled={busy}
                onClick={() =>
                  void chat
                    .startHandoff(entry.approvalId)
                    .then((ok) => ok && onFocus(entry.approvalId))
                }
              >
                {chat.codingBusy === entry.approvalId ? 'Starting…' : 'Send to coding agent'}
              </button>
            </div>
          </li>
        ) : (
          handoff.runs.map((r) => {
            const brief = briefFor(r)
            return (
              <li key={r.attempt} className="chat__turn">
                <BriefMessage
                  label={`${ORIGIN_LABEL[r.origin ?? 'start']} · attempt ${r.attempt}`}
                  summary={
                    r.steer ??
                    (r.origin === 'correction' ? 'Correct the failed local checks.' : entry.label)
                  }
                  markdown={brief?.markdown ?? null}
                  brief={brief}
                />
                <AgentReply
                  chat={chat}
                  handoff={handoff}
                  run={r}
                  latest={r === handoff.runs.at(-1)}
                  projectId={projectId}
                />
              </li>
            )
          })
        )}
      </ol>

      {chat.error && (
        <div className="dg-reject chat__error" role="alert">
          <div className="dg-reject__body">
            <span className="dg-reject__msg">{chat.error}</span>
          </div>
          <button type="button" className="link-x" onClick={chat.dismissError}>
            Dismiss
          </button>
        </div>
      )}

      <form
        className="chat__composer"
        aria-label="Message the coding agent"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <div className="chat__field" data-disabled={followUp ? undefined : ''}>
          <textarea
            className="chat__input"
            aria-label="Follow-up for the coding agent"
            rows={2}
            placeholder={
              followUp
                ? 'Follow up with the coding agent…'
                : running
                  ? 'The coding agent is working…'
                  : handoff
                    ? 'This run is closed'
                    : 'Send the handoff first'
            }
            value={text}
            disabled={!followUp}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className="chat__bar">
            <span className="chat__muted coding__hint">Same workspace, checked again locally</span>
            {handoff?.stage === 'coding' ? (
              <button
                type="button"
                className="dg-btn dg-btn--danger chat__send"
                onClick={() => void chat.cancelHandoff(handoff)}
                disabled={busy}
                title="Stop the coding agent's turn"
              >
                <span className="chat__stop" aria-hidden="true" />
                Stop
              </button>
            ) : (
              <button
                type="submit"
                className="dg-btn dg-btn--primary chat__send"
                disabled={!canSend}
                title="Send (⌘↵)"
              >
                Send <span className="dg-kbd">⌘↵</span>
              </button>
            )}
          </div>
        </div>
      </form>
    </section>
  )
}

/** What the coding agent received, as a message: rendered Markdown, the source a click away. */
function BriefMessage({
  label,
  summary,
  markdown,
  brief
}: {
  label: string
  summary: string
  markdown: string | null
  brief?: SubmittedBrief
}): React.JSX.Element {
  const [source, setSource] = useState(false)
  return (
    <div className="chat__user coding__brief">
      <span className="chat__user-context coding__label">{label}</span>
      <p>{summary}</p>
      <details className="chat__activity">
        <summary>Handoff Markdown</summary>
        <div className="chat__activity-body">
          {markdown ? (
            <>
              <div className="coding__tools">
                <button
                  type="button"
                  className="dg-btn dg-btn--ghost"
                  aria-pressed={source}
                  onClick={() => setSource((s) => !s)}
                >
                  {source ? 'Rendered' : 'Markdown source'}
                </button>
                <Copy text={markdown} label="Copy Markdown" />
              </div>
              {source ? (
                <pre className="coding__pre">{markdown}</pre>
              ) : (
                <Markdown source={markdown} plain />
              )}
            </>
          ) : (
            <p className="chat__muted">Loading the brief…</p>
          )}
          {brief && (
            <details className="chat__activity">
              <summary>
                {brief.exact ? 'Exact provider input' : 'Reconstructed provider input'} · sha256{' '}
                {brief.sha256.slice(0, 12)}
              </summary>
              <div className="chat__activity-body">
                <Copy text={brief.submitted} label="Copy input" />
                <pre className="coding__pre">{brief.submitted}</pre>
              </div>
            </details>
          )}
        </div>
      </details>
    </div>
  )
}

/** The agent's turn: shell activity inline, what it said, then the local checks' findings. */
function AgentReply({
  chat,
  handoff,
  run,
  latest,
  projectId
}: {
  chat: DesignChat
  handoff: HandoffRecord
  run: RunRecord
  latest: boolean
  projectId: string | null
}): React.JSX.Element {
  const rows = traceRows(attemptEvents(handoff, run))
  const working = latest && handoff.stage === 'coding'
  const reply = rows.findLast((row) => row.kind === 'message')
  const activity = rows.filter((row) => row !== reply)
  const lastCommand = activity.findLast((row) => row.kind === 'command')
  const summary = replySummary(handoff, run)
  const evidence = latest && handoff.stage !== 'accepted' ? failureEvidence(handoff, run) : []
  return (
    <div className="chat__assistant">
      <span className="coding__speaker dg-label">Coding agent</span>
      {activity.length > 0 && (
        <details className="chat__activity">
          <summary>
            <span className="chat__activity-head">
              {working && lastCommand
                ? `Running · ${lastCommand.text.split('\n')[0]}`
                : `Activity · ${activity.length} steps`}
            </span>
          </summary>
          <div className="chat__activity-body">
            <ol className="coding__trace">
              {activity.map((row) =>
                row.kind === 'command' ? (
                  <li key={row.key} className="coding__cmd">
                    <span aria-hidden="true">$ </span>
                    {row.text}
                  </li>
                ) : row.kind === 'output' ? (
                  <li key={row.key}>
                    {row.long ? (
                      <details>
                        <summary className="chat__muted">
                          {row.text.split('\n').length} lines of output
                        </summary>
                        <pre className="coding__pre">{row.text}</pre>
                      </details>
                    ) : (
                      <pre className="coding__pre">{row.text}</pre>
                    )}
                  </li>
                ) : row.kind === 'message' ? (
                  <li key={row.key}>
                    <Markdown source={row.text} plain />
                  </li>
                ) : (
                  <li key={row.key} data-kind={row.kind}>
                    {row.text}
                  </li>
                )
              )}
            </ol>
          </div>
        </details>
      )}
      {reply && <Markdown source={reply.text} plain />}
      {working && (
        <p className="chat__status" data-tone="info" role="status">
          <span className="chat__pulse" aria-hidden="true" />{' '}
          {rows.length ? 'Working in your code…' : 'Starting in your code…'}
        </p>
      )}
      {summary && <p className="chat__reply">{summary.text}</p>}
      {!working && run.run.status !== 'queued' && (
        <p className="chat__muted coding__provenance">
          Agent: {providerLine(run).text} · Local checks: {localLine(run).text}
        </p>
      )}
      {run.verdict && (
        <ul className="coding__checks" aria-label="Local verification checks">
          {run.verdict.obligations.map((o) => (
            <li key={o.id} title={o.diagnostic ?? o.scope}>
              <span data-tone={OUTCOME_TONE[o.outcome]}>{OUTCOME_LABEL[o.outcome]}</span>
              <span className="coding__mono">{o.id}</span>
            </li>
          ))}
        </ul>
      )}
      {evidence.length > 0 && (
        <div className="dg-reject" role="alert">
          <div className="dg-reject__body">
            <span className="dg-reject__code">Evidence</span>
            {evidence.map((line, i) => (
              <span key={i} className="dg-reject__msg">
                {line}
              </span>
            ))}
          </div>
        </div>
      )}
      {run.candidate && projectId && <Changes projectId={projectId} handoff={handoff} run={run} />}
      {latest && <LatestActions chat={chat} handoff={handoff} />}
    </div>
  )
}

/** Changed files, with the candidate diff loaded when opened. */
function Changes({
  projectId,
  handoff,
  run
}: {
  projectId: string
  handoff: HandoffRecord
  run: RunRecord
}): React.JSX.Element {
  const candidate = run.candidate!
  const [diff, setDiff] = useState<CandidateDiff | string | null>(null)
  const files = [...candidate.files, ...candidate.deleted.map((d) => `${d} (deleted)`)]
  const verified =
    run.verdict?.overall === 'pass' && run.verdict.candidateId === candidate.candidateId
  return (
    <details
      className="chat__activity"
      onToggle={(e) => {
        if (!e.currentTarget.open || diff) return
        window.api.backend.workflow
          .candidateDiff(projectId, handoff.handoffId, run.attempt)
          .then(setDiff, (err) => setDiff(message(err)))
      }}
    >
      <summary>
        <span className="chat__activity-head">
          Changed {files.length} file{files.length === 1 ? '' : 's'} ·{' '}
          {verified ? 'verified locally' : 'not verified'}
        </span>
      </summary>
      <div className="chat__activity-body">
        <ul className="chat__sources">
          {files.map((f) => (
            <li key={f}>
              <span className="chat__source">{f}</span>
            </li>
          ))}
        </ul>
        {typeof diff === 'string' ? (
          <p className="chat__status" data-tone="danger">
            {diff}
          </p>
        ) : diff ? (
          <>
            <div className="coding__head">
              <span className="chat__muted">
                {diff.candidateId.slice(0, 8)} on {diff.baseCommit.slice(0, 7)}
              </span>
              <Copy text={diff.diff} label="Copy diff" />
            </div>
            <Diff text={diff.diff} />
          </>
        ) : (
          <p className="chat__muted">Loading the diff…</p>
        )}
      </div>
    </details>
  )
}

function Diff({ text }: { text: string }): React.JSX.Element {
  return (
    <pre className="coding__pre coding__diff">
      {text.split('\n').map((line, i) => (
        <span
          key={i}
          data-line={
            line.startsWith('+++') || line.startsWith('---')
              ? 'file'
              : line.startsWith('+')
                ? 'add'
                : line.startsWith('-')
                  ? 'del'
                  : line.startsWith('@@')
                    ? 'hunk'
                    : undefined
          }
        >
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  )
}

function LatestActions({
  chat,
  handoff
}: {
  chat: DesignChat
  handoff: HandoffRecord
}): React.JSX.Element | null {
  if (handoff.stage === 'accepted') return <Deliver chat={chat} handoff={handoff} />
  if (handoff.stage !== 'correctable') return null
  const { threadId, proposalId } = handoff.correlation
  const intent = chat.project?.intents.find((i) => i.proposalId === proposalId)
  const model =
    chat.project?.turns.findLast((t) => t.threadId === threadId)?.model ?? DESIGN_MODELS[0]
  if (!intent) return null
  return (
    <div className="chat__actions">
      <button
        type="button"
        className="dg-btn"
        disabled={!!chat.pending || !!chat.codingBusy}
        title="Same handoff: the design agent reads this verdict and asks for a bounded fix"
        onClick={() =>
          void chat.send(
            `Read the local verification for approved intent ${intent.id} and request a correction for its failing checks, preserving the approved design.`,
            model,
            { status: 'none' },
            threadId
          )
        }
      >
        {chat.pending ? 'Design agent working…' : 'Ask design agent to correct'}
      </button>
    </div>
  )
}

/** The verified commit: pushed to a review branch, or saved as a patch to commit by hand. */
function Deliver({
  chat,
  handoff
}: {
  chat: DesignChat
  handoff: HandoffRecord
}): React.JSX.Element {
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'danger' } | null>(null)
  const verifiedId = handoff.runs.findLast((r) => r.verdict?.overall === 'pass')?.candidate
    ?.candidateId
  const current =
    handoff.published && handoff.published.candidateId === verifiedId ? handoff.published : null
  const save = async (): Promise<void> => {
    try {
      const v = await chat.verifiedPatch(handoff)
      const name = `diogenes-${v.candidateId.slice(0, 8)}.patch`
      const url = URL.createObjectURL(new Blob([v.patch], { type: 'text/x-patch' }))
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNote({
        text: `Saved ${name}. To commit it yourself: git switch -c diogenes-review ${v.baseCommit.slice(0, 7)} && git am ${name}, then push that branch.`,
        tone: 'ok'
      })
    } catch (e) {
      setNote({ text: `Could not get the verified patch: ${message(e)}`, tone: 'danger' })
    }
  }
  return (
    <>
      {current ? (
        <p className="chat__status" data-tone="ok" role="status">
          Published to <span className="coding__mono">{current.branch}</span> on{' '}
          {current.repository}. The default branch is unchanged.{' '}
          <a href={current.url} target="_blank" rel="noreferrer">
            Open on GitHub
          </a>
        </p>
      ) : (
        <p className="chat__muted">
          Publishing pushes this verified commit to a new diogenes/verified-… branch. The default
          branch is not touched.
        </p>
      )}
      <div className="chat__actions">
        <button type="button" className="dg-btn" onClick={() => void save()}>
          Save verified patch
        </button>
        {!current && (
          <button
            type="button"
            className="dg-btn dg-btn--primary"
            disabled={!!chat.codingBusy}
            onClick={() => void chat.publishVerified(handoff)}
          >
            {chat.codingBusy === handoff.approvalId ? 'Publishing…' : 'Publish to branch'}
          </button>
        )}
      </div>
      {note && (
        <p className="chat__status" role="status" data-tone={note.tone}>
          {note.text}
        </p>
      )}
    </>
  )
}

function Copy({ text, label }: { text: string; label: string }): React.JSX.Element {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="dg-btn dg-btn--ghost"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }
    >
      {done ? 'Copied' : label}
    </button>
  )
}
