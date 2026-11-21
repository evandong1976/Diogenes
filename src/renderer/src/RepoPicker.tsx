import { useEffect, useState } from 'react'
import type { GithubRepo, GithubUser } from '../../preload'

type Props = {
  user: GithubUser
  onPick: (repo: GithubRepo) => void
  onNew: () => void
  onSignOut: () => void
}

export function RepoPicker({ user, onPick, onNew, onSignOut }: Props): React.JSX.Element {
  const [repos, setRepos] = useState<GithubRepo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    window.api.github.listRepos().then(setRepos, (e: Error) => setError(e.message))
  }, [])

  const shown = repos?.filter((r) => r.fullName.toLowerCase().includes(query.toLowerCase()))

  return (
    <div className="screen wide">
      <header className="row">
        <h2 className="title">Pick a repository</h2>
        <span className="row">
          <span className="dg-data">@{user.login}</span>
          <button className="dg-btn dg-btn--ghost" onClick={onSignOut}>
            Sign out
          </button>
        </span>
      </header>
      <div className="row">
        <span className="muted">Open an existing repository, or start a new one.</span>
        <button className="dg-btn dg-btn--primary" onClick={onNew}>
          New repository
        </button>
      </div>
      <input
        className="dg-input"
        type="search"
        placeholder="Filter repositories"
        aria-label="Filter repositories"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!repos && !error && <p className="dg-label">Loading repositories…</p>}
      {shown?.length === 0 && <p className="muted">No repositories match.</p>}
      {!!shown?.length && (
        <ul className="repos">
          {shown.map((r) => (
            <li key={r.id}>
              <button onClick={() => onPick(r)}>
                <span className="name">{r.fullName}</span>
                <span
                  className="dg-pill"
                  style={{ color: r.private ? 'var(--dg-warn)' : 'var(--dg-text-3)' }}
                >
                  {r.private ? 'private' : 'public'}
                </span>
                {r.description && <span className="dg-data">{r.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
