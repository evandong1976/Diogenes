import { useEffect, useState } from 'react'
import type { GithubRepo, GithubUser } from '../../preload'
import { SignIn } from './SignIn'
import { RepoPicker } from './RepoPicker'
import { RepositoryCatalog } from './RepositoryCatalog'

const LEVELS = ['Infrastructure', 'Integrations', 'Code logic'] as const

function App(): React.JSX.Element {
  const [user, setUser] = useState<GithubUser | null | undefined>(undefined)
  const [repo, setRepo] = useState<GithubRepo | null>(null)
  const [level, setLevel] = useState(0)

  useEffect(() => {
    window.api.github.getUser().then(setUser, () => setUser(null))
  }, [])

  const signOut = async (): Promise<void> => {
    await window.api.github.logout()
    setRepo(null)
    setUser(null)
  }

  if (user === undefined) return <div className="screen dg-label">Loading…</div>
  if (!user) return <SignIn onSignedIn={setUser} />
  if (!repo) return <RepoPicker user={user} onPick={setRepo} onSignOut={signOut} />

  return (
    <div className="shell">
      <nav className="titlebar">
        <button className="dg-btn dg-btn--ghost" onClick={() => setRepo(null)}>
          ← {repo.fullName}
        </button>
        <div className="segmented" role="group" aria-label="Level">
          {LEVELS.map((name, i) => (
            <button key={name} onClick={() => setLevel(i)} aria-pressed={level === i}>
              L{i + 1} {name}
            </button>
          ))}
        </div>
      </nav>
      <RepositoryCatalog key={repo.id} repoId={repo.id} level={level} />
      <footer className="statusbar dg-data">
        <span>
          L{level + 1} · {LEVELS[level]}
        </span>
        <span>{repo.defaultBranch}</span>
      </footer>
    </div>
  )
}

export default App
