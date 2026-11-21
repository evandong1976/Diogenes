import { useEffect, useMemo, useState } from 'react'
import type { GithubRepo, GithubUser } from '../../preload'
import { SignIn } from './SignIn'
import { RepoPicker } from './RepoPicker'
import { CreateRepo } from './CreateRepo'
import { NewProject } from './NewProject'
import type { AppFlow } from '../../shared/gemini'
import type { IndexStatus, SoftwareGraph } from '../../shared/indexing'
import { CodeLogicLevel } from './canvas/CodeLogicLevel'
import { initialLogic, type LogicState } from './canvas/logic'
import { AppLevel } from './canvas/AppLevel'
import { EXAMPLE_DRAFT, emptyFlowDraft, type FlowDraft } from './canvas/flow'
import { indexLabel } from './canvas/indexStatus'
import { RepositoryCatalog } from './RepositoryCatalog'
import { Sidebar } from './Sidebar'
import {
  LEVELS,
  WorkspaceContext,
  emptyDraft,
  type ComponentSelection,
  type Draft
} from './canvas/components'
import { catalogKindsByLevel } from './canvas/diagrams'
import { ChatPane } from './agent/ChatPane'
import { useDesignChat, type DesignChat } from './agent/useDesignChat'

function App(): React.JSX.Element {
  const [user, setUser] = useState<GithubUser | null | undefined>(undefined)
  const [repo, setRepo] = useState<GithubRepo | null>(null)
  const [creating, setCreating] = useState(false)
  const [newRepo, setNewRepo] = useState<GithubRepo | null>(null)
  // The bundled example can be opened from sign-in without a GitHub account or repo.
  const [exampleOpen, setExampleOpen] = useState(false)
  // One canvas. A Logic box opens its state machine in place of it, until "Back to app".
  const level = 0
  const [logicOpen, setLogicOpen] = useState(false)
  const [logic, setLogic] = useState<LogicState>(initialLogic)
  // The app map Gemini read from the repo, and what the engineer proposed on top of it.
  const [flow, setFlow] = useState<AppFlow | null>(null)
  const [flowDraft, setFlowDraft] = useState<FlowDraft>(EXAMPLE_DRAFT)

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
  const [chatOpen, setChatOpen] = useState(true)

  const pickRepo = (next: GithubRepo): void => {
    window.api.gemini.useFixture()
    setLogic(initialLogic)
    setLogicOpen(false)
    setFlow(null)
    setFlowDraft(emptyFlowDraft)
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
    setLogicOpen(false)
    setFlowDraft(EXAMPLE_DRAFT)
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

  return (
    <WorkspaceContext.Provider
      value={{
        levelTag: `L${level + 1} · ${LEVELS[level].tag}`,
        draft: drafts[level] ?? emptyDraft,
        setDraft: (update) =>
          setDrafts((all) => ({ ...all, [level]: update(all[level] ?? emptyDraft) })),
        focusFile,
        onSelectComponent: setSelected
      }}
    >
      <div className="app" data-chat={shownRepo && chatOpen ? '' : undefined}>
        <Workspace
          shownRepo={shownRepo}
          catalog={catalog}
          drafts={drafts}
          level={level}
          setLevel={() => setLogicOpen(false)}
          view={view}
          setView={setView}
          indexed={shownRepo ? indexed : null}
          indexStatus={indexStatus}
          focusFile={focusFile}
          setFocusFile={setFocusFile}
          onPickRepo={pickRepo}
          chat={shownRepo ? chat : null}
          chatOpen={chatOpen}
          onChatOpen={setChatOpen}
          onConnectRepo={() => {
            if (exampleOpen) setExampleOpen(false)
            else setRepo(null)
          }}
        />
        {shownRepo && view === 'catalog' ? (
          <RepositoryCatalog key={shownRepo.id} repoId={shownRepo.id} level={level} />
        ) : (
          <main className="workspace">
            {logicOpen ? (
              <>
                <div className="logic-back">
                  <button className="dg-btn dg-btn--ghost" onClick={() => setLogicOpen(false)}>
                    ← Back to app
                  </button>
                </div>
                <CodeLogicLevel
                  repo={shownRepo}
                  logic={logic}
                  onLogicChange={setLogic}
                  catalog={catalog}
                  indexStatus={shownRepo ? indexStatus : null}
                />
              </>
            ) : (
              <AppLevel
                repo={shownRepo}
                flow={flow}
                onFlow={setFlow}
                draft={flowDraft}
                setDraft={(update) => setFlowDraft(update)}
                indexStatus={indexStatus}
                focusFile={focusFile}
                onOpenLogic={() => setLogicOpen(true)}
              />
            )}
          </main>
        )}
        {shownRepo && chatOpen && (
          <ChatPane
            chat={chat}
            selected={selected}
            onClose={() => setChatOpen(false)}
            onOpenSource={setFocusFile}
          />
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
  onConnectRepo,
  chat,
  chatOpen,
  onChatOpen
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
  chat: DesignChat | null
  chatOpen: boolean
  onChatOpen(open: boolean): void
}): React.JSX.Element {
  const levelCounts = useMemo(() => {
    if (!catalog) return [null]
    const count = (kinds: string[]): number =>
      catalog.nodes.filter((n) => kinds.includes(n.kind)).length
    return [count([...catalogKindsByLevel.infrastructure, ...catalogKindsByLevel.integrations])]
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
      chat={chat}
      chatOpen={chatOpen}
      onChatOpen={onChatOpen}
    />
  )
}

export default App
