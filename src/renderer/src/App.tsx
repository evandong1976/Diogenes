import { useEffect, useState } from 'react'
import type { GithubRepo, GithubUser } from '../../preload'
import { SignIn } from './SignIn'
import { RepoPicker } from './RepoPicker'
import { CodeLogicLevel } from './canvas/CodeLogicLevel'

const LEVELS = ['Infrastructure', 'Integrations', 'Code logic'] as const

function App(): React.JSX.Element {
  const [user, setUser] = useState<GithubUser | null | undefined>(undefined)
  const [repo, setRepo] = useState<GithubRepo | null>(null)
  // Code logic is the only level with data so far.
  const [level, setLevel] = useState(2)

  useEffect(() => {
    window.api.github.getUser().then(setUser, () => setUser(null))
  }, [])

  const signOut = async (): Promise<void> => {
    await window.api.github.logout()
    setRepo(null)
    setUser(null)
  }

  if (user === undefined) return <div className="screen muted">Loading…</div>
  if (!user) return <SignIn onSignedIn={setUser} />
  if (!repo) return <RepoPicker user={user} onPick={setRepo} onSignOut={signOut} />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <nav className="row" style={{ gap: 8, padding: 12, borderBottom: '1px solid #333' }}>
        <button className="link" onClick={() => setRepo(null)}>
          ← {repo.fullName}
        </button>
        {LEVELS.map((name, i) => (
          <button key={name} onClick={() => setLevel(i)} aria-pressed={level === i}>
            L{i + 1} · {name}
          </button>
        ))}
      </nav>
      <main style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {level === 2 ? (
          <CodeLogicLevel />
        ) : (
          <div className="screen muted" style={{ flex: 1, minHeight: 0 }}>
            No {LEVELS[level]} view yet.
          </div>
        )}
      </main>
    </div>
  )
}

export default App
