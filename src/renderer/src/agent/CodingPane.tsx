import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ApprovedChange,
  CandidateDiff,
  HandoffRecord,
  RunRecord,
  SubmittedBrief
} from '../../../shared/workflow'
import { DESIGN_MODELS } from './chat'
import {
  OUTCOME_LABEL,
  OUTCOME_TONE,
  codingEntries,
  codingSteps,
  failureEvidence,
  localLine,
  providerLine,
  selectEntry,
  traceRows
} from './coding'
import { Picker } from './Picker'
import type { DesignChat } from './useDesignChat'

interface Props {
  chat: DesignChat
  /** The approval to show; null shows the most recently active one. */
  focus: string | null
  onFocus(approvalId: string): void
  /** Hidden panes stay mounted, so the selection, view and scroll survive a tab swap. */
  hidden?: boolean
}

type View = 'handoff' | 'trace' | 'diff'
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The Coding tab: one approved change's handoff, its live run, what the provider reported, what
 * local verification found, the candidate diff, and the way out (correction, branch, patch).
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
  const approval = chat.frozen.find((a) => a.approvalId === entry?.approvalId) ?? null
  const latest = handoff?.runs.at(-1)
  const [view, setView] = useState<View>('trace')
  const [picked, setPicked] = useState<number | null>(null)
  const run = handoff?.runs.find((r) => r.attempt === picked) ?? latest
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrolled = useRef(0)

  // A different handoff opens on its newest attempt.
  const [shown, setShown] = useState(handoff?.handoffId)
  if (shown !== handoff?.handoffId) {
    setShown(handoff?.handoffId)
    setPicked(null)
  }

  useLayoutEffect(() => {
    if (!hidden && scrollRef.current) scrollRef.current.scrollTop = scrolled.current
  }, [hidden])

  // Briefs are read back from what each attempt submitted; before a start, from the packet.
  const [briefs, setBriefs] = useState<{ key: string; list: SubmittedBrief[] } | null>(null)
  const [preview, setPreview] = useState<{ key: string; text: string } | null>(null)
  const briefKey = handoff ? `${handoff.handoffId}:${handoff.runs.length}` : null
  useEffect(() => {
    if (!projectId || !handoff || !briefKey) return
    let live = true
    api.briefs(projectId, handoff.handoffId).then(
      (list) => live && setBriefs({ key: briefKey, list }),
      () => {}
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on attempts, not every poll
  }, [api, projectId, briefKey])
  const approvalId = approval?.approvalId
  useEffect(() => {
    if (!projectId || !approvalId || handoff) return
    let live = true
    api.briefPreview(projectId, approvalId).then(
      (text) => live && setPreview({ key: approvalId, text }),
      () => {}
    )
    return () => {
      live = false
    }
  }, [api, projectId, approvalId, handoff])

  const candidateId = run?.candidate?.candidateId
  const [diff, setDiff] = useState<CandidateDiff | { candidateId: string; error: string } | null>(
    null
  )
  useEffect(() => {
    if (!projectId || !handoff || !run || !candidateId) return
    let live = true
    api.candidateDiff(projectId, handoff.handoffId, run.attempt).then(
      (d) => live && setDiff(d),
      (e) => live && setDiff({ candidateId, error: message(e) })
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one fetch per candidate
  }, [api, projectId, candidateId])

  if (!entry || !approval)
    return (
      <section
        className="coding"
        id="panel-coding"
        role="tabpanel"
        aria-labelledby="tab-coding"
        hidden={hidden}
      >
        <p className="coding__empty">
          Approve a proposed change in Chat, then send it to the coding agent. Its run opens here.
        </p>
      </section>
    )

  const brief =
    briefs?.key === briefKey ? briefs.list.find((b) => b.attempt === run?.attempt) : undefined
  const provider = providerLine(run)
  const local = localLine(run)
  const steps = codingSteps(handoff)
  const evidence = handoff && run === latest ? failureEvidence(handoff, run) : []

  return (
    <section
      className="coding"
      id="panel-coding"
      role="tabpanel"
      aria-labelledby="tab-coding"
      hidden={hidden}
    >
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
      </div>

      <div
        className="coding__body"
        ref={scrollRef}
        onScroll={(e) => (scrolled.current = e.currentTarget.scrollTop)}
      >
        <ol className="coding__steps" aria-label="Progress">
          {steps.map((s) => (
            <li
              key={s.key}
              data-state={s.state}
              aria-current={s.state === 'current' ? 'step' : undefined}
            >
              {s.label}
            </li>
          ))}
        </ol>

        {handoff && (
          <dl className="coding__facts">
            <dt className="dg-label">Provider</dt>
            <dd data-tone={provider.tone}>{provider.text}</dd>
            <dt className="dg-label">Local verification</dt>
            <dd data-tone={local.tone}>{local.text}</dd>
            <dt className="dg-label">Attempt</dt>
            <dd>
              {handoff.runs.length > 1 ? (
                <span className="coding__attempts">
                  {handoff.runs.map((r) => (
                    <button
                      key={r.attempt}
                      type="button"
                      className="dg-btn dg-btn--ghost"
                      aria-pressed={r === run}
                      title={r.origin ?? 'start'}
                      onClick={() => setPicked(r.attempt)}
                    >
                      {r.attempt}
                    </button>
                  ))}
                </span>
              ) : (
                (run?.attempt ?? 1)
              )}{' '}
              <span className="chat__muted">
                of {handoff.maxAttempts} · {run?.origin ?? 'start'}
                {candidateId && ` · ${candidateId.slice(0, 8)}`}
              </span>
            </dd>
          </dl>
        )}

        {run?.verdict && (
          <ul className="coding__checks" aria-label="Local verification checks">
            {run.verdict.obligations.map((o) => (
              <li key={o.id} title={o.diagnostic ?? o.scope}>
                <span data-tone={OUTCOME_TONE[o.outcome]}>{OUTCOME_LABEL[o.outcome]}</span>
                <span className="coding__mono">{o.id}</span>
              </li>
            ))}
          </ul>
        )}

        {evidence.length > 0 && handoff?.stage !== 'accepted' && (
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

        {chat.error && (
          <p className="chat__status" data-tone="danger" role="alert">
            {chat.error}
          </p>
        )}

        <Actions chat={chat} handoff={handoff} approvalId={entry.approvalId} onFocus={onFocus} />

        <div className="coding__views" role="tablist" aria-label="Run detail">
          {(['handoff', 'trace', 'diff'] as const).map((v) => (
            <button
              key={v}
              role="tab"
              type="button"
              className="leftpane__tab dg-label"
              aria-selected={view === v}
              onClick={() => setView(v)}
            >
              {v === 'handoff' ? 'Handoff' : v === 'trace' ? 'Trace' : 'Diff'}
            </button>
          ))}
        </div>

        {view === 'handoff' && (
          <HandoffView
            packet={approval.packet}
            brief={brief}
            preview={!handoff && preview?.key === approval.approvalId ? preview.text : null}
          />
        )}
        {view === 'trace' && <TraceView run={run} live={handoff?.stage === 'coding'} />}
        {view === 'diff' &&
          (!candidateId ? (
            <p className="chat__muted">No candidate yet.</p>
          ) : diff && diff.candidateId === candidateId ? (
            'error' in diff ? (
              <p className="chat__status" data-tone="danger">
                {diff.error}
              </p>
            ) : (
              <DiffView diff={diff} verified={run?.verdict?.overall === 'pass'} />
            )
          ) : (
            <p className="chat__muted">Loading the candidate…</p>
          ))}
      </div>
    </section>
  )
}

function Actions({
  chat,
  handoff,
  approvalId,
  onFocus
}: {
  chat: DesignChat
  handoff: HandoffRecord | null
  approvalId: string
  onFocus(approvalId: string): void
}): React.JSX.Element | null {
  const busy = !!chat.codingBusy
  if (!handoff)
    return (
      <div className="chat__actions">
        <button
          type="button"
          className="dg-btn dg-btn--primary"
          disabled={busy}
          onClick={() => void chat.startHandoff(approvalId).then((ok) => ok && onFocus(approvalId))}
        >
          {chat.codingBusy === approvalId ? 'Starting…' : 'Send to coding agent'}
        </button>
      </div>
    )
  if (handoff.stage === 'coding')
    return (
      <div className="chat__actions">
        <button
          type="button"
          className="dg-btn"
          disabled={busy}
          onClick={() => void chat.cancelHandoff(handoff)}
        >
          {chat.codingBusy === approvalId ? 'Stopping…' : 'Stop coding'}
        </button>
      </div>
    )
  if (handoff.stage === 'correctable') {
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
          disabled={!!chat.pending || busy}
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
  if (handoff.stage === 'accepted') return <Deliver chat={chat} handoff={handoff} />
  return null
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
  const { published } = handoff
  const verifiedId = handoff.runs.findLast((r) => r.verdict?.overall === 'pass')?.candidate
    ?.candidateId
  const current = published && published.candidateId === verifiedId ? published : null
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
          Publishing pushes this verified commit to a new diogenes/verified-… branch of the
          repository. The default branch is not touched.
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

/** Constraints and checks from the frozen packet, then the exact Markdown the agent got. */
function HandoffView({
  packet,
  brief,
  preview
}: {
  packet: ApprovedChange
  brief: SubmittedBrief | undefined
  preview: string | null
}): React.JSX.Element {
  const scope = packet.kind === 'catalog' ? packet.scope : [packet.bindings.root]
  const markdown = brief?.markdown ?? preview
  return (
    <div className="coding__section">
      <Group title="Required" items={packet.requiredChanges} />
      <Group title="Must stay the same" items={packet.preserved} />
      <Group title="Edit only" items={scope} mono />
      <Group
        title="Accepted only if"
        items={packet.obligations.map((o) => `${o.id}: ${o.scope}`)}
      />
      <div className="coding__head">
        <span className="dg-label">
          {brief
            ? `Brief sent · attempt ${brief.attempt} · ${brief.origin}`
            : preview
              ? 'Brief to send'
              : 'Brief'}
        </span>
        {markdown && <Copy text={markdown} label="Copy Markdown" />}
      </div>
      {markdown ? (
        <pre className="coding__pre">{markdown}</pre>
      ) : (
        <p className="chat__muted">Loading the brief…</p>
      )}
      {brief && (
        <details className="chat__activity">
          <summary>
            <span className="chat__activity-head">
              Exact provider input · sha256 {brief.sha256.slice(0, 12)}
              {brief.sources.length > 0 && ` · ${brief.sources.length} staged files`}
            </span>
          </summary>
          <div className="coding__head">
            <span />
            <Copy text={brief.submitted} label="Copy input" />
          </div>
          <pre className="coding__pre">{brief.submitted}</pre>
        </details>
      )}
    </div>
  )
}

function Group({
  title,
  items,
  mono
}: {
  title: string
  items: string[]
  mono?: boolean
}): React.JSX.Element | null {
  if (!items.length) return null
  return (
    <div className="coding__group">
      <span className="dg-label">{title}</span>
      <ul className={mono ? 'coding__mono' : undefined}>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

function TraceView({
  run,
  live
}: {
  run: RunRecord | undefined
  live: boolean
}): React.JSX.Element {
  const rows = traceRows(run?.run.events ?? [])
  return (
    <div className="coding__section">
      {live && (
        <p className="chat__status" data-tone="info" role="status">
          <span className="chat__pulse" aria-hidden="true" /> Coding agent working
        </p>
      )}
      {rows.length === 0 ? (
        <p className="chat__muted">
          {live ? 'No activity reported yet.' : 'No activity recorded.'}
        </p>
      ) : (
        <ol className="coding__trace" aria-live="polite">
          {rows.map((row) =>
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
            ) : (
              <li key={row.key} data-kind={row.kind}>
                {row.kind === 'steer' && <span className="dg-label">Direction </span>}
                {row.text}
              </li>
            )
          )}
        </ol>
      )}
    </div>
  )
}

function DiffView({
  diff,
  verified
}: {
  diff: CandidateDiff
  verified: boolean
}): React.JSX.Element {
  return (
    <div className="coding__section">
      <div className="coding__head">
        <span className="dg-label">
          Candidate {diff.candidateId.slice(0, 8)} on {diff.baseCommit.slice(0, 7)} ·{' '}
          {verified ? 'verified locally' : 'not verified'}
        </span>
        <Copy text={diff.diff} label="Copy diff" />
      </div>
      <Group
        title="Changed files"
        items={[...diff.files, ...diff.deleted.map((d) => `${d} (deleted)`)]}
        mono
      />
      <pre className="coding__pre coding__diff">
        {diff.diff.split('\n').map((line, i) => (
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
    </div>
  )
}
