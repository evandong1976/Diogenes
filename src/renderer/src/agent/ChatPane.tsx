import { useEffect, useMemo, useRef, useState } from 'react'
import type { DraftState, EvidenceRecord, Proposal, TurnRecord } from '../../../shared/design'
import type { ApprovalRecord } from '../../../shared/workflow'
import {
  DESIGN_MODELS,
  TURN_STATUS_LABEL,
  TURN_STATUS_TONE,
  buildTranscript,
  checkSelection,
  proposalIsBehind,
  runningTurn,
  type SelectionCheck,
  type TurnItem
} from './chat'
import type { ApprovalOutcome, DesignChat } from './useDesignChat'

interface Props {
  chat: DesignChat
  /** The catalog component selected on the canvas, if any. */
  selected: { componentId: string; label: string } | null
  onClose(): void
}

const time = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** The project's design conversation: threads, transcript, context, composer and proposals. */
export function ChatPane({ chat, selected, onClose }: Props): React.JSX.Element {
  const { load, draft, project, activeId, pending } = chat
  const [text, setText] = useState('')
  const [attach, setAttach] = useState(true)
  const [modelChoice, setModelChoice] = useState<string | null>(null)
  const logRef = useRef<HTMLOListElement>(null)

  // A new canvas selection is attached by default; the developer can detach it for one send.
  useEffect(() => setAttach(true), [selected?.componentId])

  const items = useMemo(
    () => (activeId ? buildTranscript(chat.events, project, activeId, chat.sent) : []),
    [chat.events, project, activeId, chat.sent]
  )
  const lastModel = [...items].reverse().find((i) => i.kind === 'turn' && i.turn)
  const model =
    modelChoice ?? (lastModel?.kind === 'turn' ? lastModel.turn?.model : null) ?? DESIGN_MODELS[0]

  const selection = checkSelection(draft, selected)
  const sendSelection: SelectionCheck = attach ? selection : { status: 'none' }
  const pendingHere = pending && pending.threadId === activeId ? pending : null
  const live = activeId ? runningTurn(project, activeId) : null
  const ready = load.status === 'ready' && !!draft
  const canSend = ready && !pending && !!text.trim()

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [items.length, pendingHere, live?.toolCalls.length])

  const send = async (): Promise<void> => {
    if (!canSend) return
    const ok = await chat.send(text, model, sendSelection)
    if (ok) setText('')
  }

  return (
    <aside className="chat" aria-label="Design chat">
      <header className="chat__head">
        <span className="dg-label">Design chat</span>
        <span className="dg-data chat__ref" title={draft ? draft.commitSha : undefined}>
          {draft ? `DRAFT r${draft.revision} · ${draft.commitSha.slice(0, 7)}` : ''}
        </span>
        <button className="link-x" onClick={onClose} aria-label="Close design chat">
          ✕
        </button>
      </header>

      {load.status === 'ready' && (
        <div className="chat__threads">
          <select
            className="dg-input"
            aria-label="Design thread"
            value={activeId ?? ''}
            onChange={(e) => chat.openThread(e.target.value)}
            disabled={!chat.threads.length}
          >
            {!chat.threads.length && <option value="">No threads yet</option>}
            {chat.threads.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          <button className="dg-btn" onClick={() => void chat.newThread()} disabled={!!pending}>
            New thread
          </button>
        </div>
      )}

      <LoadState chat={chat} />

      <ol className="chat__log" ref={logRef} aria-live="polite">
        {ready && !items.length && !pendingHere && (
          <li className="chat__empty dg-data">
            {activeId
              ? 'No messages in this thread yet.'
              : 'Ask about the architecture or describe a change. Sending starts a thread.'}
          </li>
        )}
        {items.map((item) =>
          item.kind === 'note' ? (
            <li key={item.key} className="chat__note dg-data">
              <span className="dg-label">Workflow · {time(item.at)}</span>
              <p>{item.text}</p>
            </li>
          ) : pendingHere && item.turn?.status === 'running' ? null : (
            <Turn key={item.key} item={item} chat={chat} draft={draft} />
          )
        )}
        {pendingHere && (
          <li className="chat__turn">
            <Message who="You" text={pendingHere.text} />
            <ContextChip selection={pendingHere.selection} />
            <div className="chat__reply">
              <div className="chat__meta">
                <span className="dg-label">Gemini · {pendingHere.model}</span>
                <span className="dg-pill" data-tone="info" role="status">
                  {live ? 'Running' : 'Sending'}
                </span>
              </div>
              <Activity turn={live} open />
              <p className="dg-data">
                {live
                  ? 'Reading the graph and source. The reply appears when the turn finishes.'
                  : 'Waiting for the backend to start the turn…'}
              </p>
            </div>
          </li>
        )}
      </ol>

      {chat.error && (
        <div className="dg-reject chat__error" role="alert">
          <div className="dg-reject__body">
            <span className="dg-reject__code">Error</span>
            <span className="dg-reject__msg">{chat.error}</span>
          </div>
          <button className="link-x" onClick={chat.dismissError}>
            Dismiss
          </button>
        </div>
      )}

      <form
        className="chat__composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <div className="chat__context">
          <SelectionControl
            selection={selection}
            attached={attach}
            onAttach={setAttach}
            draft={draft}
          />
          <select
            className="dg-input chat__model"
            aria-label="Model for the next turn"
            title="Model for the next turn"
            value={model}
            onChange={(e) => setModelChoice(e.target.value)}
          >
            {DESIGN_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="prompt">
          <label htmlFor="design-chat" className="prompt__caret">
            &gt;
          </label>
          <textarea
            id="design-chat"
            className="dg-input"
            rows={2}
            placeholder={ready ? 'Ask or describe a change to the graph' : 'Design chat unavailable'}
            value={text}
            disabled={!ready}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void send()
              }
            }}
          />
        </div>
        <div className="chat__actions">
          {pending ? (
            <button
              type="button"
              className="dg-btn dg-btn--ghost"
              onClick={chat.cancel}
              disabled={!live}
              title={live ? 'Stop this turn' : 'The turn has not started yet'}
            >
              Stop
            </button>
          ) : (
            <span />
          )}
          <button type="submit" className="dg-btn dg-btn--primary" disabled={!canSend}>
            Send <span className="dg-kbd">⌘↵</span>
          </button>
        </div>
      </form>
    </aside>
  )
}

function LoadState({ chat }: { chat: DesignChat }): React.JSX.Element | null {
  const { load } = chat
  if (load.status === 'ready' || load.status === 'off') return null
  if (load.status === 'loading')
    return (
      <p className="chat__state dg-data" role="status">
        Opening the design draft…
      </p>
    )
  if (load.status === 'waiting')
    return (
      <p className="chat__state dg-data" role="status">
        {load.message}
      </p>
    )
  return (
    <div className="dg-reject chat__error" role="alert">
      <div className="dg-reject__body">
        <span className="dg-reject__code">Unavailable</span>
        <span className="dg-reject__msg">{load.message}</span>
      </div>
      <button className="dg-btn" onClick={chat.reload}>
        Retry
      </button>
    </div>
  )
}

function Message({ who, text, at }: { who: string; text: string | null; at?: string }): React.JSX.Element {
  return (
    <div className="chat__msg">
      <span className="dg-label">
        {who}
        {at && ` · ${time(at)}`}
      </span>
      {text !== null ? <p>{text}</p> : <p className="dg-data">Message not recorded in this thread.</p>}
    </div>
  )
}

function Turn({
  item,
  chat,
  draft
}: {
  item: TurnItem
  chat: DesignChat
  draft: DraftState | null
}): React.JSX.Element {
  const { turn } = item
  // The thread's assistant event repeats the error when there was no reply; show it once.
  const reply = turn?.reply ?? (turn?.error ? null : item.reply)
  return (
    <li className="chat__turn">
      <Message who="You" text={item.text} at={item.at} />
      {turn && <TurnSelection turn={turn} />}
      <div className="chat__reply">
        <div className="chat__meta">
          <span className="dg-label">Gemini{turn ? ` · ${turn.model}` : ''}</span>
          {turn && (
            <span className="dg-pill" data-tone={TURN_STATUS_TONE[turn.status]}>
              {TURN_STATUS_LABEL[turn.status]}
            </span>
          )}
        </div>
        {turn && <Activity turn={turn} />}
        {reply && <p>{reply}</p>}
        {turn?.error && <p className="error">{turn.error}</p>}
        {turn?.status === 'interrupted' && (
          <p className="dg-data">The app stopped while this turn ran. The draft was not changed by it.</p>
        )}
        {item.proposal && <ProposalCard proposal={item.proposal} chat={chat} draft={draft} />}
      </div>
    </li>
  )
}

/** What the backend made of the selection the turn carried. */
function TurnSelection({ turn }: { turn: TurnRecord }): React.JSX.Element | null {
  const s = turn.selection
  if (s.status === 'none') return null
  if (s.status === 'resolved')
    return (
      <span className="chat__chip dg-data" data-tone="accent">
        @{s.name} · {s.kind}
      </span>
    )
  return (
    <span className="chat__chip dg-data" data-tone="warn">
      @{s.componentId} not found: {s.message}
    </span>
  )
}

function ContextChip({ selection }: { selection: SelectionCheck }): React.JSX.Element | null {
  if (selection.status !== 'ok') return null
  return (
    <span className="chat__chip dg-data" data-tone="accent">
      @{selection.name} · {selection.kind}
    </span>
  )
}

function SelectionControl({
  selection,
  attached,
  onAttach,
  draft
}: {
  selection: SelectionCheck
  attached: boolean
  onAttach(attached: boolean): void
  draft: DraftState | null
}): React.JSX.Element {
  if (selection.status === 'none')
    return <span className="dg-data chat__hint">Select a component on the canvas to add it as context</span>
  if (selection.status === 'missing')
    return (
      <span className="chat__chip dg-data" data-tone="warn" title={selection.componentId}>
        @{selection.label} isn&apos;t in draft r{draft?.revision ?? '?'}; not sent
      </span>
    )
  return attached ? (
    <span className="chat__chip dg-data" data-tone="accent" title={selection.componentId}>
      @{selection.name}
      <button
        type="button"
        className="link-x"
        aria-label={`Don't send ${selection.name} as context`}
        onClick={() => onAttach(false)}
      >
        ✕
      </button>
    </span>
  ) : (
    <button type="button" className="link-x" onClick={() => onAttach(true)}>
      + Attach @{selection.name}
    </button>
  )
}

function Activity({ turn, open }: { turn: TurnRecord | null; open?: boolean }): React.JSX.Element | null {
  if (!turn || (!turn.toolCalls.length && !turn.evidence.length)) return null
  return (
    <details className="chat__activity" open={open}>
      <summary className="dg-data">
        {turn.toolCalls.length} tool call{turn.toolCalls.length === 1 ? '' : 's'}
        {turn.evidence.length > 0 && ` · ${turn.evidence.length} source excerpt${turn.evidence.length === 1 ? '' : 's'}`}
      </summary>
      <ul>
        {turn.toolCalls.map((c, i) => (
          <li key={i} className="dg-data" data-tone={c.ok ? undefined : 'danger'}>
            <span className="chat__tool">{c.name}</span> {c.summary}
          </li>
        ))}
      </ul>
      {turn.evidence.length > 0 && <Evidence evidence={turn.evidence} />}
    </details>
  )
}

/** Evidence lines are 0-based, end-exclusive; the design system shows 1-based `start–end`. */
function Evidence({ evidence }: { evidence: EvidenceRecord[] }): React.JSX.Element {
  return (
    <div className="dg-evidence-list">
      <div className="dg-evidence-list__head">
        <span>{evidence.length} sources</span>
      </div>
      {evidence.map((e) => (
        <div key={e.id} className="dg-evidence-list__row" title={`${e.path} @ ${e.commitSha.slice(0, 7)}`}>
          <span className="dg-evidence-list__kind">CODE</span>
          <span className="dg-evidence__path">{e.path}</span>
          <span className="dg-evidence-list__range">
            {e.startLine + 1}–{Math.max(e.startLine + 1, e.endLine)}
          </span>
        </div>
      ))}
    </div>
  )
}

const CHANGE_CODE = { added: 'ADD', updated: 'UPD', removed: 'DEL' } as const
const PROPOSAL_TONE = { pending: 'accent', approved: 'ok', rejected: 'info', stale: 'warn' } as const

function ProposalCard({
  proposal,
  chat,
  draft
}: {
  proposal: Proposal
  chat: DesignChat
  draft: DraftState | null
}): React.JSX.Element {
  const { preview } = proposal
  const behind = proposalIsBehind(proposal, draft)
  const busy = chat.deciding === proposal.id || !!chat.pending
  const outcome = chat.approvals[proposal.id]
  return (
    <section className="chat-proposal" data-status={proposal.status} aria-label="Proposed graph change">
      <div className="chat__meta">
        <span className="dg-label">
          Proposal · r{preview.baseRevision} → r{preview.resultRevision}
        </span>
        <span className="dg-pill" data-tone={PROPOSAL_TONE[proposal.status]}>
          {proposal.status}
        </span>
      </div>
      <p>{proposal.summary}</p>
      {(preview.components.length > 0 || preview.connections.length > 0) && (
        <ul className="chat-proposal__changes">
          {preview.components.map((c) => (
            <li key={`n-${c.id}`} className="dg-data" title={c.id}>
              <span className="chat-proposal__code" data-change={c.change}>
                {CHANGE_CODE[c.change]}
              </span>
              {c.name}
            </li>
          ))}
          {preview.connections.map((c) => (
            <li key={`e-${c.id}`} className="dg-data" title={c.id}>
              <span className="chat-proposal__code" data-change={c.change}>
                {CHANGE_CODE[c.change]}
              </span>
              {c.kind} · {c.from} → {c.to}
            </li>
          ))}
        </ul>
      )}
      {proposal.evidence.length > 0 && <Evidence evidence={proposal.evidence} />}
      {behind && (
        <p className="chat__chip dg-data" data-tone="warn">
          Checked against r{preview.baseRevision}; the draft is now r{draft!.revision}. Approval will
          be refused as stale. Ask for the change again against the current draft.
        </p>
      )}
      {proposal.reason && proposal.status !== 'pending' && (
        <p className="dg-data">{proposal.reason}</p>
      )}
      <ApprovalState proposal={proposal} outcome={outcome} frozen={chat.frozen} />
      {proposal.status === 'pending' && (
        <div className="chat__actions">
          <button className="dg-btn dg-btn--ghost" disabled={busy} onClick={() => void chat.discard(proposal)}>
            Discard
          </button>
          <button
            className="dg-btn dg-btn--primary"
            disabled={busy}
            onClick={() => void chat.approve(proposal)}
          >
            {chat.deciding === proposal.id ? 'Approving…' : 'Approve'}
          </button>
        </div>
      )}
    </section>
  )
}

function ApprovalState({
  proposal,
  outcome,
  frozen
}: {
  proposal: Proposal
  outcome: ApprovalOutcome | undefined
  frozen: ApprovalRecord[]
}): React.JSX.Element | null {
  if (outcome?.kind === 'refused')
    return (
      <div className="dg-reject" role="alert">
        <div className="dg-reject__body">
          <span className="dg-reject__code">Rejected · {outcome.code}</span>
          <span className="dg-reject__msg">
            {outcome.message}
            {outcome.currentRevision !== undefined && ` The draft is at r${outcome.currentRevision}.`}
          </span>
        </div>
      </div>
    )
  if (proposal.status !== 'approved') return null
  const record = frozen.find((a) => a.correlation.proposalId === proposal.id)
  if (outcome?.kind === 'draft-only' && !record)
    return (
      <p className="chat__chip dg-data" data-tone="warn">
        Applied to draft r{outcome.revision}. No coding handoff was frozen: {outcome.message}
      </p>
    )
  const id = record?.approvalId ?? (outcome?.kind === 'frozen' ? outcome.approvalId : null)
  return (
    <p className="chat__chip dg-data" data-tone="ok">
      Applied to the draft
      {id ? ` · frozen for coding as ${id.slice(0, 12)}` : ' · no coding handoff recorded'}
    </p>
  )
}
