import { useEffect, useState } from 'react'
import type { GithubRepo, GithubUser } from '../../preload'

type Props = {
  user: GithubUser
  onPick: (repo: GithubRepo) => void
  onSignOut: () => void
}

export function RepoPicker({ user, onPick, onSignOut }: Props): React.JSX.Element {
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
        <h2>Pick a repository</h2>
        <span className="muted">
          {user.login} ·{' '}
          <button className="link" onClick={onSignOut}>
            Sign out
          </button>
        </span>
      </header>
      <input
        type="search"
        placeholder="Filter repositories"
        aria-label="Filter repositories"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      {error && <p role="alert">{error}</p>}
      {!repos && !error && <p className="muted">Loading repositories…</p>}
      {shown?.length === 0 && <p className="muted">No repositories match.</p>}
      <ul className="repos">
        {shown?.map((r) => (
          <li key={r.id}>
            <button onClick={() => onPick(r)}>
              <strong>{r.fullName}</strong>
              {r.private && <span className="badge">private</span>}
              {r.description && <span className="muted">{r.description}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
