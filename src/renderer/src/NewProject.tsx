import { useState } from 'react'
import type { GithubRepo } from '../../preload'

type Props = { repo: GithubRepo; onExit: () => void }

// The blank project screen for a freshly created repo: an empty canvas slot and the chat dock.
// The canvas team mounts their canvas in <main>. Chat replies and agent handoff come later.
export function NewProject({ repo, onExit }: Props): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<string[]>([])

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setMessages((m) => [...m, text])
    setDraft('')
  }

  return (
    <div className="shell project">
      <nav className="titlebar">
        <button className="dg-btn dg-btn--ghost" onClick={onExit}>
          ← {repo.fullName}
        </button>
        <span className="dg-pill" style={{ color: 'var(--dg-ok)' }}>
          new
        </span>
      </nav>

      <main className="canvas-empty" aria-label="Canvas">
        {messages.length === 0 && (
          <div className="empty-hint">
            <h1 className="title">Describe what you want to build</h1>
            <p className="muted">
              Or draw it on the canvas. When the plan looks right, send it to your agent.
            </p>
          </div>
        )}
      </main>

      <section className="dock" aria-label="Chat">
        {messages.length > 0 && (
          <ol className="thread" aria-live="polite">
            {messages.map((m, i) => (
              <li key={i}>
                <span className="dg-label">You</span>
                <p>{m}</p>
              </li>
            ))}
          </ol>
        )}
        <form
          className="prompt"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <label htmlFor="chat" className="prompt__caret">
            &gt;
          </label>
          <textarea
            id="chat"
            className="dg-input"
            rows={1}
            placeholder="Describe the system. Use @ to reference a node."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                send()
              }
            }}
            autoFocus
          />
          <span className="dg-kbd">@</span>
          <button type="submit" className="dg-btn" disabled={!draft.trim()}>
            Send <span className="dg-kbd">⌘↵</span>
          </button>
        </form>
      </section>
    </div>
  )
}
