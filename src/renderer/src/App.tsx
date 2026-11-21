import { useEffect, useState } from 'react'
import type { GithubRepo, GithubUser } from '../../preload'
import { SignIn } from './SignIn'
import { RepoPicker } from './RepoPicker'
import type { Architecture } from '../../shared/gemini'
import type { IndexStatus } from '../../shared/indexing'
import { CodeLogicLevel } from './canvas/CodeLogicLevel'
import { initialLogic, type LogicState } from './canvas/logic'
import { ArchitectureLevel } from './canvas/ArchitectureLevel'
import { indexLabel } from './canvas/indexStatus'
import { RepositoryCatalog } from './RepositoryCatalog'

const LEVELS = ['Infrastructure', 'Integrations', 'Code logic'] as const

function App(): React.JSX.Element {
  const [user, setUser] = useState<GithubUser | null | undefined>(undefined)
  const [repo, setRepo] = useState<GithubRepo | null>(null)
  // Code logic opens first: it works from the saved example without any API calls.
  const [level, setLevel] = useState(2)
  // Held here so switching levels keeps each level's diagram.
  const [logic, setLogic] = useState<LogicState>(initialLogic)
  const [architecture, setArchitecture] = useState<Architecture | null>(null)

  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null)
  // Canvas draws the diagrams; Catalog is the searchable list where catalog entries are edited.
  const [view, setView] = useState<'canvas' | 'catalog'>('canvas')

  const pickRepo = (next: GithubRepo): void => {
    window.api.gemini.useFixture()
    setLogic(initialLogic)
    setArchitecture(null)
    setIndexStatus(null)
    setRepo(next)
    // Index in the background; diagrams use it as evidence once it's ready.
    window.api.indexing.start(next.id).then(setIndexStatus, (e: unknown) =>
      setIndexStatus({
        repoId: next.id,
        fullName: next.fullName,
        state: 'failed',
        error: e instanceof Error ? e.message : String(e),
        lastIndexed: null
      })
    )
  }

  useEffect(() => {
    window.api.github.getUser().then(setUser, () => setUser(null))
  }, [])

  const repoId = repo?.id
  useEffect(() => {
    if (repoId === undefined) return
    return window.api.indexing.onStatus((status) => {
      if (status.repoId === repoId) setIndexStatus(status)
    })
  }, [repoId])

  const signOut = async (): Promise<void> => {
    await window.api.github.logout()
    setRepo(null)
    setUser(null)
  }

  if (user === undefined) return <div className="screen dg-label">Loading…</div>
  if (!user) return <SignIn onSignedIn={setUser} />
  if (!repo) return <RepoPicker user={user} onPick={pickRepo} onSignOut={signOut} />

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
        <div className="segmented" role="group" aria-label="View">
          <button onClick={() => setView('canvas')} aria-pressed={view === 'canvas'}>
            Canvas
          </button>
          <button onClick={() => setView('catalog')} aria-pressed={view === 'catalog'}>
            Catalog
          </button>
        </div>
      </nav>
      {view === 'catalog' ? (
        <RepositoryCatalog key={repo.id} repoId={repo.id} level={level} />
      ) : (
        <main className="workspace">
          {level === 2 ? (
            <CodeLogicLevel repo={repo} logic={logic} onLogicChange={setLogic} />
          ) : (
            <ArchitectureLevel
              repo={repo}
              level={level === 0 ? 'infrastructure' : 'integrations'}
              architecture={architecture}
              onArchitectureChange={setArchitecture}
              indexStatus={indexStatus}
            />
          )}
        </main>
      )}
      <footer className="statusbar dg-data">
        <span>
          L{level + 1} · {LEVELS[level]}
        </span>
        <span>{repo.defaultBranch}</span>
        <span>{indexLabel(indexStatus)}</span>
      </footer>
    </div>
  )
}

export default App
