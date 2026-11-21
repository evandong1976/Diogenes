import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type {
  DraftState,
  EvidenceRecord,
  Proposal,
  TurnRecord,
  WhiteboardSnapshot
} from '../../../shared/design'
import type { ApprovalRecord } from '../../../shared/workflow'
import {
  DESIGN_MODELS,
  activityTrace,
  buildTranscript,
  checkSelection,
  proposalIsBehind,
  runningTurn,
  type SelectionCheck,
  type TurnItem
} from './chat'
import { Picker } from './Picker'
import type { ApprovalOutcome, DesignChat } from './useDesignChat'

interface Props {
  chat: DesignChat
  /** The catalog component selected on the canvas, if any. */
  selected: { componentId: string; label: string } | null
  /** Hidden panes stay mounted, so the draft, thread and scroll survive a collapse. */
  hidden?: boolean
  /** Highlights a source file in the sidebar tree and on the canvas. */
  onOpenSource?(path: string): void
  /** The whiteboard on screen, sent with each message so the agent can propose changes to it. */
  whiteboard?: WhiteboardSnapshot | null
}

/** Source rows link to the file tree; provided once by the pane. */
const OpenSource = createContext<((path: string) => void) | null>(null)

const time = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

const MODEL_OPTIONS = DESIGN_MODELS.map((m) => ({ value: m, label: m }))

/** The project's design conversation: threads, transcript, context, composer and proposals. */
export function ChatPane({
  chat,
  selected,
  hidden,
  onOpenSource,
  whiteboard
}: Props): React.JSX.Element {
  const { load, draft, project, activeId, pending } = chat
  const [text, setText] = useState('')
  // The component the developer removed from the message; a new canvas selection is attached.
  const [detached, setDetached] = useState<string | null>(null)
  const [modelChoice, setModelChoice] = useState<string | null>(null)
  const logRef = useRef<HTMLOListElement>(null)
  // Follow new activity only while the reader is at the bottom; remember where they were.
  const pinned = useRef(true)
  const scrolled = useRef(0)

  const items = useMemo(
    () => (activeId ? buildTranscript(chat.events, project, activeId, chat.sent) : []),
    [chat.events, project, activeId, chat.sent]
  )
  const lastModel = [...items].reverse().find((i) => i.kind === 'turn' && i.turn)
  const model =
    modelChoice ?? (lastModel?.kind === 'turn' ? lastModel.turn?.model : null) ?? DESIGN_MODELS[0]

  const selection = checkSelection(draft, selected)
  const attached = selection.status === 'ok' && detached !== selection.componentId
  const sendSelection: SelectionCheck = attached ? selection : { status: 'none' }
  const pendingHere = pending && pending.threadId === activeId ? pending : null
  const live = activeId ? runningTurn(project, activeId) : null
  const ready = load.status === 'ready' && !!draft
  const canSend = ready && !pending && !!text.trim()

  // A different thread opens at its latest message.
  useEffect(() => {
    pinned.current = true
  }, [activeId])

  // Reopening the pane puts the transcript back where it was left.
  useLayoutEffect(() => {
    const log = logRef.current
    if (hidden || !log) return
    log.scrollTop = pinned.current ? log.scrollHeight : scrolled.current
  }, [hidden])

  useEffect(() => {
    const log = logRef.current
    if (hidden || !log || !pinned.current) return
    log.scrollTop = log.scrollHeight
  }, [hidden, activeId, items.length, pendingHere, live?.toolCalls.length])

  const onScroll = (): void => {
    const log = logRef.current
    if (hidden || !log) return
    scrolled.current = log.scrollTop
    pinned.current = log.scrollHeight - log.scrollTop - log.clientHeight < 32
  }

  const send = async (): Promise<void> => {
    if (!canSend) return
    pinned.current = true
    const ok = await chat.send(text, model, sendSelection, whiteboard)
    if (ok) setText('')
  }

  return (
    <OpenSource.Provider value={onOpenSource ?? null}>
      <section
        className="chat"
        id="panel-chat"
        role="tabpanel"
        aria-labelledby="tab-chat"
        hidden={hidden}
      >
        {load.status === 'ready' && (
          <div className="chat__threads">
            <Picker
              className="chat__thread-picker"
              label="Design thread"
              placeholder="New conversation"
              value={activeId}
              disabled={!chat.threads.length}
              options={chat.threads.map((t) => ({
                value: t.id,
                label: t.title,
                hint: chat.pending?.threadId === t.id ? 'working' : undefined
              }))}
              onChange={chat.openThread}
            />
            <button
              type="button"
              className="dg-btn dg-btn--ghost chat__icon-btn"
              onClick={() => void chat.newThread()}
              disabled={!!pending}
              aria-label="New thread"
              title={pending ? 'Wait for the running turn to finish' : 'New thread'}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
        )}

        <LoadState chat={chat} />

        <ol className="chat__log" ref={logRef} onScroll={onScroll} aria-live="polite">
          {items.map((item) =>
            item.kind === 'note' ? (
              <li key={item.key} className="chat__note" title={time(item.at)}>
                {item.text}
              </li>
            ) : pendingHere && item.turn?.status === 'running' ? null : (
              <Turn key={item.key} item={item} chat={chat} draft={draft} />
            )
          )}
          {pendingHere && (
            <li className="chat__turn">
              <UserMessage
                text={pendingHere.text}
                context={pendingHere.selection.status === 'ok' ? pendingHere.selection.name : null}
              />
              <div className="chat__assistant">
                <Activity turn={live} live />
              </div>
            </li>
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
          aria-label="Message Gemini"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          <div className="chat__field" data-disabled={ready ? undefined : ''}>
            {selection.status === 'ok' && (
              <div className="chat__context">
                {attached ? (
                  <span className="chat__attach" title={selection.componentId}>
                    <span className="chat__attach-name">{selection.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${selection.name} from this message`}
                      title="Remove from this message"
                      onClick={() => setDetached(selection.componentId)}
                    >
                      ×
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="chat__attach chat__attach--off"
                    title={`Attach ${selection.name} to this message`}
                    onClick={() => setDetached(null)}
                  >
                    + {selection.name}
                  </button>
                )}
              </div>
            )}
            <textarea
              id="design-chat"
              className="chat__input"
              aria-label="Message"
              rows={2}
              placeholder={ready ? 'Ask or describe a change…' : 'Design chat unavailable'}
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
            <div className="chat__bar">
              <Picker
                className="chat__model"
                label="Model for the next turn"
                heading="Model for the next turn"
                value={model}
                options={MODEL_OPTIONS}
                onChange={setModelChoice}
                up
              />
              {pending ? (
                <button
                  type="button"
                  className="dg-btn dg-btn--danger chat__send"
                  onClick={chat.cancel}
                  disabled={!live}
                  title={live ? 'Stop the running turn' : 'Starting the turn…'}
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
    </OpenSource.Provider>
  )
}

function LoadState({ chat }: { chat: DesignChat }): React.JSX.Element | null {
  const { load } = chat
  if (load.status === 'ready' || load.status === 'off') return null
  if (load.status === 'loading')
    return (
      <p className="chat__state" role="status">
        Opening the design draft…
      </p>
    )
  if (load.status === 'waiting')
    return (
      <p className="chat__state" role="status">
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

function UserMessage({
  text,
  context,
  title
}: {
  text: string | null
  /** The component sent with the message, if any. */
  context: string | null
  title?: string
}): React.JSX.Element {
  return (
    <div className="chat__user" title={title}>
      {context && <span className="chat__user-context">{context}</span>}
      {text !== null ? (
        <p>{text}</p>
      ) : (
        <p className="chat__muted">Message not recorded in this thread.</p>
      )}
    </div>
  )
}

/** Only outcomes that need attention get a line; a finished turn speaks for itself. */
const STATUS_NOTE: Partial<Record<TurnRecord['status'], string>> = {
  cancelled: 'Stopped.',
  interrupted: 'The app closed while this turn ran. The draft was not changed.',
  'stale-graph': 'The draft changed before this ran. Send it again.'
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
  const context =
    turn?.selection.status === 'resolved'
      ? turn.selection.name
      : turn?.selection.status === 'missing'
        ? turn.selection.componentId
        : null
  const note = turn && STATUS_NOTE[turn.status]
  return (
    <li className="chat__turn">
      <UserMessage
        text={item.text}
        context={context}
        title={`${time(item.at)}${turn ? ` · ${turn.model}` : ''}`}
      />
      <div className="chat__assistant">
        {turn && <Activity turn={turn} />}
        {reply && <p className="chat__reply">{reply}</p>}
        {turn?.error && (
          <p className="chat__status" data-tone="danger">
            {turn.error}
          </p>
        )}
        {note && !turn?.error && (
          <p className="chat__status" data-tone="warn">
            {note}
          </p>
        )}
        {item.proposal && <ProposalCard proposal={item.proposal} chat={chat} draft={draft} />}
      </div>
    </li>
  )
}

/**
 * The turn's recorded tool calls and the code it read, folded into one quiet line. While the
 * turn runs, the line shows the newest step; expanding it lists every step and source.
 */
function Activity({
  turn,
  live
}: {
  turn: TurnRecord | null
  /** True while this window is waiting on the turn. */
  live?: boolean
}): React.JSX.Element | null {
  const trace = activityTrace(turn)
  const working = live || trace.phase === 'working'
  const hasDetail = trace.steps.length > 0 || trace.evidence.length > 0
  if (!working && !hasDetail) return null
  return (
    <details className="chat__activity" data-phase={working ? 'working' : trace.phase}>
      <summary role={working ? 'status' : undefined} data-empty={hasDetail ? undefined : ''}>
        {working && <span className="chat__pulse" aria-hidden="true" />}
        <span className="chat__activity-head">{trace.headline}</span>
      </summary>
      {hasDetail && (
        <div className="chat__activity-body">
          {trace.steps.length > 0 && (
            <ol className="chat__trace">
              {trace.steps.map((step) => (
                <li key={step.key} data-ok={step.ok} title={`${step.tool} ${step.args}`}>
                  <span className="chat__tool">{step.label}</span>
                  <span>{step.summary}</span>
                </li>
              ))}
            </ol>
          )}
          {trace.evidence.length > 0 && <Sources evidence={trace.evidence} />}
        </div>
      )}
    </details>
  )
}

/** Evidence lines are 0-based, end-exclusive; shown 1-based as `start–end`. */
function Sources({ evidence }: { evidence: EvidenceRecord[] }): React.JSX.Element {
  const open = useContext(OpenSource)
  return (
    <ul className="chat__sources">
      {evidence.map((e) => {
        const range = `${e.startLine + 1}–${Math.max(e.startLine + 1, e.endLine)}`
        return (
          <li key={e.id} title={`${e.path}:${range} @ ${e.commitSha.slice(0, 7)}`}>
            {open ? (
              <button type="button" className="chat__source" onClick={() => open(e.path)}>
                {e.path}
              </button>
            ) : (
              <span className="chat__source">{e.path}</span>
            )}
            <span className="chat__range">{range}</span>
          </li>
        )
      })}
    </ul>
  )
}

const CHANGE_MARK = { added: '+', updated: '~', removed: '−' } as const
const PROPOSAL_STATUS = {
  pending: null,
  approved: { label: 'Approved', tone: 'ok' },
  rejected: { label: 'Discarded', tone: 'info' },
  stale: { label: 'Stale', tone: 'warn' }
} as const

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
  const status = PROPOSAL_STATUS[proposal.status]
  return (
    <section
      className="chat-proposal"
      data-status={proposal.status}
      aria-label="Proposed graph change"
    >
      <header className="chat-proposal__head">
        <span className="chat-proposal__title">Proposed change</span>
        <span className="chat-proposal__rev">
          r{preview.baseRevision} → r{preview.resultRevision}
        </span>
        {status && (
          <span className="chat-proposal__status" data-tone={status.tone}>
            {status.label}
          </span>
        )}
      </header>
      <p>{proposal.summary}</p>
      {(preview.components.length > 0 || preview.connections.length > 0) && (
        <ul className="chat-proposal__changes">
          {preview.components.map((c) => (
            <li key={`n-${c.id}`} title={c.id} data-change={c.change}>
              <span className="chat-proposal__mark">{CHANGE_MARK[c.change]}</span>
              {c.name}
            </li>
          ))}
          {preview.connections.map((c) => (
            <li key={`e-${c.id}`} title={c.id} data-change={c.change}>
              <span className="chat-proposal__mark">{CHANGE_MARK[c.change]}</span>
              {c.from} → {c.to}
              <span className="chat__muted"> · {c.kind}</span>
            </li>
          ))}
        </ul>
      )}
      {proposal.evidence.length > 0 && (
        <details className="chat__activity">
          <summary>
            <span className="chat__activity-head">
              Based on {proposal.evidence.length} source
              {proposal.evidence.length === 1 ? '' : 's'}
            </span>
          </summary>
          <div className="chat__activity-body">
            <Sources evidence={proposal.evidence} />
          </div>
        </details>
      )}
      {behind && (
        <p className="chat__status" data-tone="warn">
          Checked against r{preview.baseRevision}; the draft is now r{draft!.revision}, so approval
          will be refused. Ask again against the current draft.
        </p>
      )}
      {proposal.reason && proposal.status !== 'pending' && (
        <p className="chat__muted">{proposal.reason}</p>
      )}
      <ApprovalState proposal={proposal} outcome={outcome} frozen={chat.frozen} />
      {proposal.status === 'pending' && (
        <div className="chat__actions">
          <button
            type="button"
            className="dg-btn"
            disabled={busy}
            title="Discard; the draft stays as it is"
            onClick={() => void chat.discard(proposal)}
          >
            Discard
          </button>
          <button
            type="button"
            className="dg-btn dg-btn--primary"
            disabled={busy}
            title={`Apply to the draft as r${preview.resultRevision}`}
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
            {outcome.currentRevision !== undefined &&
              ` The draft is at r${outcome.currentRevision}.`}
          </span>
        </div>
      </div>
    )
  if (proposal.status !== 'approved') return null
  const record = frozen.find((a) => a.correlation.proposalId === proposal.id)
  if (outcome?.kind === 'draft-only' && !record)
    return (
      <p className="chat__status" data-tone="warn">
        Applied to draft r{outcome.revision}. No coding handoff was frozen: {outcome.message}
      </p>
    )
  const id = record?.approvalId ?? (outcome?.kind === 'frozen' ? outcome.approvalId : null)
  return (
    <p className="chat__status" data-tone="ok">
      Applied to the draft
      {id ? ` · frozen for coding as ${id.slice(0, 12)}` : ' · no coding handoff recorded'}
    </p>
  )
}
