import { useEffect, useMemo, useState } from 'react'
import type { GithubRepo, GithubUser } from '../../preload'
import { SignIn } from './SignIn'
import { RepoPicker } from './RepoPicker'
import { CreateRepo } from './CreateRepo'
import { NewProject } from './NewProject'
import type { Architecture } from '../../shared/gemini'
import type { IndexStatus, SoftwareGraph } from '../../shared/indexing'
import { CodeLogicLevel } from './canvas/CodeLogicLevel'
import { initialLogic, type LogicState } from './canvas/logic'
import { ArchitectureLevel } from './canvas/ArchitectureLevel'
import { indexLabel } from './canvas/indexStatus'
import { RepositoryCatalog } from './RepositoryCatalog'
import { Sidebar } from './Sidebar'
import { PaneResizer } from './PaneResizer'
import { savedChatWidth } from './chatWidth'
import {
  LEVELS,
  WorkspaceContext,
  emptyDraft,
  type ComponentSelection,
  type Draft
} from './canvas/components'
import { catalogKindsByLevel } from './canvas/diagrams'
import { ChatPane } from './agent/ChatPane'
import { useDesignChat } from './agent/useDesignChat'

function App(): React.JSX.Element {
  const [user, setUser] = useState<GithubUser | null | undefined>(undefined)
  const [repo, setRepo] = useState<GithubRepo | null>(null)
  const [creating, setCreating] = useState(false)
  const [newRepo, setNewRepo] = useState<GithubRepo | null>(null)
  // The bundled example can be opened from sign-in without a GitHub account or repo.
  const [exampleOpen, setExampleOpen] = useState(false)
  // Code logic opens first: it works from the saved example without any API calls.
  const [level, setLevel] = useState(2)
  // Held here so switching levels keeps each level's diagram.
  const [logic, setLogic] = useState<LogicState>(initialLogic)
  const [architecture, setArchitecture] = useState<Architecture | null>(null)

  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null)
  // Canvas draws the diagrams; Catalog is the searchable list where catalog entries are edited.
  const [view, setView] = useState<'canvas' | 'catalog'>('canvas')

  // The indexed graph; its `catalog` is what the architecture levels draw.
  const [indexed, setIndexed] = useState<SoftwareGraph | null>(null)

  // What the user drew on each level's canvas, and the file picked in the sidebar.
  const [drafts, setDrafts] = useState<Record<number, Draft>>({})
  const [focusFile, setFocusFile] = useState<string | null>(null)
  // The catalog component selected on the canvas, offered to the design chat as context.
  const [selected, setSelected] = useState<ComponentSelection | null>(null)
  // Side panes collapse independently; the chat stays mounted while hidden so nothing resets.
  const [leftOpen, setLeftOpen] = useState(true)
  const [leftTab, setLeftTab] = useState<'chat' | 'project'>('chat')
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [chatWidth, setChatWidth] = useState(savedChatWidth)
  const [resizing, setResizing] = useState(false)

  // ⌘\ toggles the left pane, ⌘⇧\ the inspector (matching the toolbar tooltips).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.code !== 'Backslash') return
      e.preventDefault()
      if (e.shiftKey) setInspectorOpen((o) => !o)
      else setLeftOpen((o) => !o)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const pickRepo = (next: GithubRepo): void => {
    window.api.gemini.useFixture()
    setLogic(initialLogic)
    setArchitecture(null)
    setIndexStatus(null)
    setIndexed(null)
    setDrafts({})
    setFocusFile(null)
    setSelected(null)
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

  const openExample = (): void => {
    void window.api.gemini.useFixture()
    setLogic(initialLogic)
    setLevel(2)
    setView('canvas')
    setExampleOpen(true)
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

  // Load the published graph whenever a finished snapshot appears or changes (cached, or fresh).
  const publishedSha = indexStatus?.lastIndexed?.sha
  // The design backend is project-scoped to a GitHub repo, so example mode has no chat.
  const chatProject = !exampleOpen && repo ? String(repo.id) : null
  const chat = useDesignChat(chatProject, chatProject ? (publishedSha ?? null) : null)
  useEffect(() => {
    if (repoId === undefined || !publishedSha) return
    let active = true
    window.api.indexing.getGraph(repoId).then(
      (graph) => active && setIndexed(graph),
      () => active && setIndexed(null)
    )
    return () => {
      active = false
    }
  }, [repoId, publishedSha])

  const signOut = async (): Promise<void> => {
    await window.api.github.logout()
    setRepo(null)
    setNewRepo(null)
    setCreating(false)
    setUser(null)
  }

  if (user === undefined) return <div className="screen dg-label">Loading…</div>
  if (!exampleOpen) {
    if (!user) return <SignIn onSignedIn={setUser} onOpenExample={openExample} />
    if (newRepo) return <NewProject repo={newRepo} onExit={() => setNewRepo(null)} />
    if (creating)
      return (
        <CreateRepo
          user={user}
          onCreated={(r) => {
            setCreating(false)
            setNewRepo(r)
          }}
          onCancel={() => setCreating(false)}
        />
      )
    if (!repo)
      return (
        <RepoPicker
          user={user}
          onPick={pickRepo}
          onNew={() => setCreating(true)}
          onSignOut={signOut}
        />
      )
  }

  // Example mode has no repo: only the Code logic level, on the bundled fixture.
  const shownRepo = exampleOpen ? null : repo
  const catalog = shownRepo ? (indexed?.catalog ?? null) : null
  // Example mode has no backend project, so its left pane is Project only.
  const tab = shownRepo ? leftTab : 'project'

  return (
    <WorkspaceContext.Provider
      value={{
        levelTag: `L${level + 1} · ${LEVELS[level].tag}`,
        draft: drafts[level] ?? emptyDraft,
        setDraft: (update) =>
          setDrafts((all) => ({ ...all, [level]: update(all[level] ?? emptyDraft) })),
        focusFile,
        onSelectComponent: setSelected,
        panes: {
          left: leftOpen,
          inspector: inspectorOpen,
          leftTab: tab,
          setLeft: setLeftOpen,
          setInspector: setInspectorOpen
        }
      }}
    >
      <div
        className="app"
        data-left={leftOpen ? tab : 'closed'}
        data-resizing={resizing ? '' : undefined}
      >
        <div
          className="leftpane"
          hidden={!leftOpen}
          style={{ '--dg-chat-w': `${chatWidth}px` } as React.CSSProperties}
        >
          {tab === 'chat' && (
            <PaneResizer width={chatWidth} onWidth={setChatWidth} onDragging={setResizing} />
          )}
          <div className="leftpane__tabs" role="tablist" aria-label="Left pane">
            <button
              role="tab"
              id="tab-chat"
              className="leftpane__tab dg-label"
              aria-selected={tab === 'chat'}
              aria-controls="panel-chat"
              disabled={!shownRepo}
              title={shownRepo ? 'Design chat' : 'Design chat needs a GitHub repo'}
              onClick={() => setLeftTab('chat')}
            >
              Chat
              {chat.pending && (
                <span className="leftpane__busy" aria-label="agent working">
                  ●
                </span>
              )}
            </button>
            <button
              role="tab"
              id="tab-project"
              className="leftpane__tab dg-label"
              aria-selected={tab === 'project'}
              aria-controls="panel-project"
              title="Repository, levels and files"
              onClick={() => setLeftTab('project')}
            >
              Project
            </button>
            <button
              type="button"
              className="dg-btn dg-btn--ghost pane-toggle leftpane__hide"
              aria-label={`Hide ${tab === 'chat' ? 'design chat' : 'project'}`}
              title={`Hide ${tab === 'chat' ? 'design chat' : 'project'} (⌘\\)`}
              onClick={() => setLeftOpen(false)}
            >
              ⟨
            </button>
          </div>
          <div
            className="leftpane__panel"
            role="tabpanel"
            id="panel-project"
            aria-labelledby="tab-project"
            hidden={tab !== 'project'}
          >
            <Workspace
              shownRepo={shownRepo}
              catalog={catalog}
              drafts={drafts}
              level={level}
              setLevel={setLevel}
              view={view}
              setView={setView}
              indexed={shownRepo ? indexed : null}
              indexStatus={indexStatus}
              focusFile={focusFile}
              setFocusFile={setFocusFile}
              onPickRepo={pickRepo}
              onConnectRepo={() => {
                if (exampleOpen) setExampleOpen(false)
                else setRepo(null)
              }}
            />
          </div>
          {shownRepo && (
            <ChatPane
              chat={chat}
              selected={selected}
              hidden={!leftOpen || tab !== 'chat'}
              onOpenSource={setFocusFile}
            />
          )}
        </div>
        {shownRepo && view === 'catalog' ? (
          <RepositoryCatalog key={shownRepo.id} repoId={shownRepo.id} level={level} />
        ) : (
          <main className="workspace">
            {!shownRepo || level === 2 ? (
              <CodeLogicLevel
                repo={shownRepo}
                logic={logic}
                onLogicChange={setLogic}
                catalog={catalog}
                indexStatus={shownRepo ? indexStatus : null}
              />
            ) : (
              <ArchitectureLevel
                repo={shownRepo}
                level={level === 0 ? 'infrastructure' : 'integrations'}
                architecture={architecture}
                onArchitectureChange={setArchitecture}
                indexStatus={indexStatus}
                catalog={catalog}
                indexed={indexed}
              />
            )}
          </main>
        )}
        <footer className="statusbar dg-data">
          <span>
            L{level + 1} · {LEVELS[level].name}
          </span>
          <span>{shownRepo?.defaultBranch ?? 'Bundled example'}</span>
          {shownRepo && <span>{indexLabel(indexStatus)}</span>}
        </footer>
      </div>
    </WorkspaceContext.Provider>
  )
}

/** The sidebar plus the counts it shows, derived from the catalog and the user's drafts. */
function Workspace({
  shownRepo,
  catalog,
  drafts,
  level,
  setLevel,
  view,
  setView,
  indexed,
  indexStatus,
  focusFile,
  setFocusFile,
  onPickRepo,
  onConnectRepo
}: {
  shownRepo: GithubRepo | null
  catalog: SoftwareGraph['catalog'] | null
  drafts: Record<number, Draft>
  level: number
  setLevel(level: number): void
  view: 'canvas' | 'catalog'
  setView(view: 'canvas' | 'catalog'): void
  indexed: SoftwareGraph | null
  indexStatus: IndexStatus | null
  focusFile: string | null
  setFocusFile(path: string | null): void
  onPickRepo(repo: GithubRepo): void
  onConnectRepo(): void
}): React.JSX.Element {
  const levelCounts = useMemo(() => {
    if (!catalog) return [null, null, null]
    const count = (kinds: string[]): number =>
      catalog.nodes.filter((n) => kinds.includes(n.kind)).length
    return [
      count(catalogKindsByLevel.infrastructure),
      count(catalogKindsByLevel.integrations),
      // Logic also works from the bundled example, so 0 machines isn't "empty".
      count(['stateMachine']) || null
    ]
  }, [catalog])

  const fileCounts = useMemo(() => {
    const counts = new Map<string, number>()
    const add = (paths: Iterable<string>): void => {
      for (const p of new Set(paths)) counts.set(p, (counts.get(p) ?? 0) + 1)
    }
    for (const n of catalog?.nodes ?? []) add(n.sources.map((s) => s.path))
    for (const d of Object.values(drafts)) for (const paths of Object.values(d.links)) add(paths)
    return counts
  }, [catalog, drafts])

  return (
    <Sidebar
      repo={shownRepo}
      onPickRepo={onPickRepo}
      onConnectRepo={onConnectRepo}
      level={level}
      onLevel={setLevel}
      levelCounts={levelCounts}
      view={view}
      onView={setView}
      indexed={indexed}
      indexLabel={indexLabel(indexStatus)}
      fileCounts={fileCounts}
      focusFile={focusFile}
      onFocusFile={setFocusFile}
    />
  )
}

export default App
