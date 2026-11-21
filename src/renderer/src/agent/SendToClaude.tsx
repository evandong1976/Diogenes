import { useEffect, useRef, useState } from 'react'
import type { ClaudeAgent, ClaudeSendResult } from '../../../shared/claudeAgents'
import type { Proposal } from '../../../shared/design'
import { claudePrompt } from './claudePrompt'

const NEW_AGENT = 'new'

/** Picks a running Claude Code agent and hands it the approved change. */
export function SendToClaude({
  proposal,
  onClose
}: {
  proposal: Proposal
  onClose(): void
}): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [agents, setAgents] = useState<ClaudeAgent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<(ClaudeSendResult & { name: string }) | null>(null)
  const [scan, setScan] = useState(0)
  const prompt = claudePrompt(proposal)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  useEffect(() => {
    let live = true
    window.api.claude.listAgents(proposal.projectId).then(
      (list) => {
        if (!live) return
        setAgents(list)
        setError(null)
        setChoice((c) => c ?? list.find((a) => a.inRepo)?.sessionId ?? null)
      },
      (e: Error) => live && setError(e.message)
    )
    return () => {
      live = false
    }
  }, [proposal.projectId, scan])

  const send = async (): Promise<void> => {
    if (!choice) return
    setSending(true)
    setError(null)
    try {
      if (choice === NEW_AGENT) {
        const r = await window.api.claude.sendNew(prompt)
        if (r) setSent({ ...r, name: 'New Claude agent' })
      } else {
        const r = await window.api.claude.send(choice, prompt)
        setSent({ ...r, name: agents?.find((a) => a.sessionId === choice)?.name ?? 'Claude' })
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  return (
    <dialog
      ref={ref}
      className="claude-send"
      onClose={onClose}
      aria-labelledby="claude-send-title"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.metaKey && choice && !sending && !sent) void send()
      }}
    >
      <header className="row">
        <h2 id="claude-send-title" className="title">
          Send to a Claude agent
        </h2>
        <button type="button" className="dg-btn dg-btn--ghost" onClick={() => ref.current?.close()}>
          Close
        </button>
      </header>

      {sent ? (
        <div className="claude-send__done" role="status">
          <p>
            <strong>{sent.name}</strong> is working on it in the background in{' '}
            <span className="dg-data">{sent.cwd}</span>.
          </p>
          {sent.id && (
            <p className="muted">
              Watch or reply in a terminal: <code className="dg-kbd">claude attach {sent.id}</code>
            </p>
          )}
          <div className="row">
            {sent.id && (
              <button
                type="button"
                className="dg-btn"
                onClick={() => navigator.clipboard.writeText(`claude attach ${sent.id}`)}
              >
                Copy command
              </button>
            )}
            <button
              type="button"
              className="dg-btn dg-btn--primary"
              onClick={() => ref.current?.close()}
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="muted">
            Claude Code sessions running on this computer. The agent works in its own folder, so
            pick one that has this repository checked out.
          </p>
          <div className="row">
            <span className="dg-label">{agents ? `${agents.length} running` : 'Scanning…'}</span>
            <button
              type="button"
              className="dg-btn dg-btn--ghost"
              onClick={() => setScan((n) => n + 1)}
            >
              Rescan
            </button>
          </div>
          <ul className="claude-send__list" role="radiogroup" aria-label="Claude agents">
            {agents?.map((a) => (
              <li key={a.sessionId}>
                <label
                  className="claude-send__agent"
                  data-checked={choice === a.sessionId || undefined}
                >
                  <input
                    type="radio"
                    name="claude-agent"
                    checked={choice === a.sessionId}
                    onChange={() => setChoice(a.sessionId)}
                  />
                  <span className="claude-send__name">{a.name}</span>
                  {a.inRepo && (
                    <span className="dg-pill" style={{ color: 'var(--dg-ok)' }}>
                      this repo
                    </span>
                  )}
                  <span className="dg-pill" style={{ color: 'var(--dg-text-3)' }}>
                    {a.kind} · {a.status}
                  </span>
                  <span className="dg-data claude-send__cwd">{a.cwd}</span>
                </label>
              </li>
            ))}
            <li>
              <label
                className="claude-send__agent"
                data-checked={choice === NEW_AGENT || undefined}
              >
                <input
                  type="radio"
                  name="claude-agent"
                  checked={choice === NEW_AGENT}
                  onChange={() => setChoice(NEW_AGENT)}
                />
                <span className="claude-send__name">Start a new agent…</span>
                <span className="dg-data claude-send__cwd">
                  Choose a folder after you press Send
                </span>
              </label>
            </li>
          </ul>
          {agents && !agents.some((a) => a.inRepo) && (
            <p className="dg-data">
              No running agent has this repository checked out. Start one in your checkout, or pick
              a folder for a new agent.
            </p>
          )}
          <details>
            <summary className="dg-label">What Claude will receive</summary>
            <pre className="claude-send__prompt dg-data">{prompt}</pre>
          </details>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row">
            <span className="dg-data">Runs in the background; nothing is pushed.</span>
            <button
              type="button"
              className="dg-btn dg-btn--primary"
              disabled={!choice || sending}
              onClick={() => void send()}
            >
              {sending ? 'Sending…' : 'Send'}
              <span className="dg-kbd">⌘↵</span>
            </button>
          </div>
        </>
      )}
    </dialog>
  )
}
