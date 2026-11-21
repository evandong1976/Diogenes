import { useEffect, useState } from 'react'
import type { GithubRepo, GithubUser } from '../../preload'
import { SignIn } from './SignIn'
import { RepoPicker } from './RepoPicker'
import type { Architecture } from '../../shared/gemini'
import { CodeLogicLevel } from './canvas/CodeLogicLevel'
import { initialLogic, type LogicState } from './canvas/logic'
import { ArchitectureLevel } from './canvas/ArchitectureLevel'

const LEVELS = ['Infrastructure', 'Integrations', 'Code logic'] as const

function App(): React.JSX.Element {
  const [user, setUser] = useState<GithubUser | null | undefined>(undefined)
  const [repo, setRepo] = useState<GithubRepo | null>(null)
  const [exampleOpen, setExampleOpen] = useState(false)
  // Code logic opens first: it works from the saved example without any API calls.
  const [level, setLevel] = useState(2)
  // Held here so switching levels keeps each level's diagram.
  const [logic, setLogic] = useState<LogicState>(initialLogic)
  const [architecture, setArchitecture] = useState<Architecture | null>(null)

  const pickRepo = (next: GithubRepo): void => {
    window.api.gemini.useFixture()
    setLogic(initialLogic)
    setArchitecture(null)
    setRepo(next)
  }

  useEffect(() => {
    window.api.github.getUser().then(setUser, () => setUser(null))
  }, [])

  const signOut = async (): Promise<void> => {
    await window.api.github.logout()
    setRepo(null)
    setUser(null)
  }

  if (user === undefined) return <div className="screen dg-label">Loading…</div>
  if (!exampleOpen) {
    if (!user) {
      return (
        <SignIn
          onSignedIn={setUser}
          onOpenExample={() => {
            void window.api.gemini.useFixture()
            setLogic(initialLogic)
            setLevel(2)
            setExampleOpen(true)
          }}
        />
      )
    }
    if (!repo) return <RepoPicker user={user} onPick={pickRepo} onSignOut={signOut} />
  }

  return (
    <div className="shell">
      <nav className="titlebar">
        <button
          className="dg-btn dg-btn--ghost"
          onClick={() => {
            if (exampleOpen) setExampleOpen(false)
            else setRepo(null)
          }}
        >
          ← {repo?.fullName ?? 'Back to sign in'}
        </button>
        {repo && (
          <div className="segmented" role="group" aria-label="Level">
            {LEVELS.map((name, i) => (
              <button key={name} onClick={() => setLevel(i)} aria-pressed={level === i}>
                L{i + 1} {name}
              </button>
            ))}
          </div>
        )}
      </nav>
      <main className="workspace">
        {!repo || level === 2 ? (
          <CodeLogicLevel repo={repo} logic={logic} onLogicChange={setLogic} />
        ) : (
          <ArchitectureLevel
            repo={repo}
            level={level === 0 ? 'infrastructure' : 'integrations'}
            architecture={architecture}
            onArchitectureChange={setArchitecture}
          />
        )}
      </main>
      <footer className="statusbar dg-data">
        <span>
          L{level + 1} · {LEVELS[level]}
        </span>
        <span>{repo?.defaultBranch ?? 'Bundled example'}</span>
      </footer>
    </div>
  )
}

export default App
