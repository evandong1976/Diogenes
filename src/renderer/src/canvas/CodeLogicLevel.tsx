import { useEffect, useMemo, useRef, useState } from 'react'
import type { GithubRepo } from '../../../preload'
import type { CatalogGraph } from '../../../shared/catalog'
import type { CurrentGraph, ProposedEdit } from '../../../shared/gemini'
import type { IndexStatus } from '../../../shared/indexing'
import { applyEdit } from '../../../shared/graph'
import { checksFromEdits, isRetryOnceExample } from '../../../shared/checks'
import { DiagramCanvas } from './DiagramCanvas'
import { DrawLayer } from './DrawLayer'
import { catalogStateMachines, stateDiagram, stateGraphFromCatalog } from './diagrams'
import { exampleEdit, initialLogic, shouldAutoBuild, type LogicState } from './logic'

// Gemini proposes from structure and the drawing; source lines are display-only here, and the
// main process may not hold the files they point into (an indexed state machine, for example).
const withoutSources = (graph: CurrentGraph): CurrentGraph => ({
  initialStateId: graph.initialStateId,
  states: graph.states.map((s) => ({ ...s, sources: [] })),
  transitions: graph.transitions.map((t) => ({ ...t, sources: [] }))
})

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface Props {
  repo: GithubRepo | null
  logic: LogicState
  onLogicChange: React.Dispatch<React.SetStateAction<LogicState>>
  /** State machines the index found can be loaded without calling Gemini. */
  catalog: CatalogGraph | null
  /** The repo is built automatically once indexing settles, so the index can rank its files. */
  indexStatus: IndexStatus | null
}

export function CodeLogicLevel({
  repo,
  logic,
  onLogicChange,
  catalog,
  indexStatus
}: Props): React.JSX.Element {
  const machines = useMemo(() => catalogStateMachines(catalog), [catalog])
  const canvasRef = useRef<HTMLDivElement>(null)
  const [drawing, setDrawing] = useState(false)
  const [hasInk, setHasInk] = useState(false)
  const [clearKey, setClearKey] = useState(0)
  const [proposal, setProposal] = useState<ProposedEdit | null>(null)
  const [question, setQuestion] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const managedPending = logic.managed?.kind === 'running'
  const blocked = !!busy || managedPending

  const diagram = useMemo(() => stateDiagram(logic.graph, proposal), [logic.graph, proposal])

  const reset = (): void => {
    setProposal(null)
    setQuestion(null)
    setDrawing(false)
    setClearKey((k) => k + 1)
  }

  const run = async (label: string, task: () => Promise<void>): Promise<void> => {
    setBusy(label)
    setError(null)
    try {
      await task()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(null)
    }
  }

  // Every replacement keeps `autoBuiltFor`, so returning to the example never rebuilds the repo.
  const replaceLogic = (next: Omit<LogicState, 'version' | 'autoBuiltFor'>): void =>
    onLogicChange((current) => ({
      ...next,
      version: current.version + 1,
      autoBuiltFor: current.autoBuiltFor
    }))

  const buildFromRepo = (): Promise<void> =>
    run(repo ? `Finding the state machine in ${repo.fullName}…` : 'Reading repo…', async () => {
      if (!repo) return
      const { graph, files } = await window.api.gemini.buildRepoGraph({
        id: repo.id,
        fullName: repo.fullName,
        branch: repo.defaultBranch
      })
      reset()
      replaceLogic({
        graph,
        source: `${repo.fullName} · ${files.length} file${files.length === 1 ? '' : 's'} read`,
        isExample: false
      })
    })

  // Opening a repo builds its own state machine once, after indexing settles (finished or failed).
  // Until then, and if that build fails, the bundled example stays on the canvas.
  const autoBuild = shouldAutoBuild(repo?.id, logic, indexStatus?.state)
  useEffect(() => {
    if (!autoBuild || !repo) return
    onLogicChange((current) => ({ ...current, autoBuiltFor: repo.id }))
    void buildFromRepo()
    // Runs when the conditions first hold; buildFromRepo reads the latest props itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBuild])

  const loadMachine = (id: string): void => {
    const machine = machines.find((m) => m.id === id)
    if (!machine) return
    reset()
    setError(null)
    replaceLogic({
      graph: stateGraphFromCatalog(machine),
      source: `Index · ${machine.name}`,
      isExample: false,
      machine: { id: machine.id, name: machine.name }
    })
  }

  const useExample = (): Promise<void> =>
    run('Loading example…', async () => {
      await window.api.gemini.useFixture()
      reset()
      replaceLogic({
        graph: initialLogic.graph,
        source: initialLogic.source,
        isExample: true
      })
    })

  const propose = (): Promise<void> =>
    run('Asking Gemini…', async () => {
      const rect = canvasRef.current!.getBoundingClientRect()
      const png = await window.api.canvas.capture({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      })
      const result = await window.api.gemini.proposeEdit(withoutSources(logic.graph), png)
      setDrawing(false)
      if (result.kind === 'edit') {
        setProposal(result)
        setQuestion(null)
      } else {
        setProposal(null)
        setQuestion(result.question)
      }
    })

  // Every approved edit is kept, in order, against the graph as it was before the first one, so
  // the managed agent implements and verifies the whole change, not just the latest step.
  const approve = (): void => {
    if (!proposal) return
    const approved = logic.approved
      ? { ...logic.approved, edits: [...logic.approved.edits, proposal] }
      : {
          graph: logic.graph,
          edits: [proposal],
          repo:
            repo && !logic.isExample
              ? { id: repo.id, fullName: repo.fullName, branch: repo.defaultBranch }
              : undefined
        }
    onLogicChange({
      graph: applyEdit(logic.graph, proposal),
      source: logic.source.endsWith('· edited') ? logic.source : `${logic.source} · edited`,
      isExample: logic.isExample,
      machine: logic.machine,
      approved,
      version: logic.version + 1,
      autoBuiltFor: logic.autoBuiltFor
    })
    reset()
  }

  // What the agent will be held to, shown before it runs.
  const plannedChecks = useMemo(() => {
    const approved = logic.approved
    if (!approved) return null
    if (!approved.repo && isRetryOnceExample(approved.edits)) return 'fixture' as const
    return checksFromEdits(approved.graph, approved.edits)
  }, [logic.approved])

  const runManaged = async (): Promise<void> => {
    const approved = logic.approved
    if (!approved || managedPending) return
    onLogicChange({ ...logic, managed: { kind: 'running' } })

    try {
      const result = await window.api.gemini.runManagedChange({
        graph: approved.graph,
        edits: approved.edits,
        repo: approved.repo
      })
      onLogicChange((current) =>
        current.approved === approved ? { ...current, managed: { kind: 'done', result } } : current
      )
    } catch (error) {
      onLogicChange((current) =>
        current.approved === approved
          ? { ...current, managed: { kind: 'error', message: message(error) } }
          : current
      )
    }
  }

  const managedResult = logic.managed?.kind === 'done' ? logic.managed.result : null

  return (
    <div className="level">
      <div className="toolbar row">
        <span className="dg-label">{logic.source}</span>
        <div className="row">
          {proposal ? (
            <>
              <span className="dg-data">{proposal.summary}</span>
              <button className="dg-btn dg-btn--ghost" onClick={reset}>
                Discard
              </button>
              <button className="dg-btn dg-btn--primary" onClick={approve}>
                Approve
              </button>
            </>
          ) : (
            <>
              <button
                className={drawing ? 'dg-btn dg-btn--primary' : 'dg-btn'}
                aria-pressed={drawing}
                disabled={blocked}
                onClick={() => setDrawing((d) => !d)}
              >
                {drawing ? 'Drawing' : 'Draw'}
              </button>
              {hasInk && (
                <button className="dg-btn dg-btn--ghost" onClick={() => setClearKey((k) => k + 1)}>
                  Clear
                </button>
              )}
              <button className="dg-btn" onClick={propose} disabled={!hasInk || blocked}>
                Propose change
              </button>
              {logic.isExample && logic.source === initialLogic.source && (
                <button
                  className="dg-btn dg-btn--ghost"
                  disabled={blocked}
                  onClick={() => setProposal(exampleEdit)}
                >
                  Saved proposal
                </button>
              )}
              {logic.approved && (
                <button className="dg-btn dg-btn--primary" onClick={runManaged} disabled={blocked}>
                  Run managed agent
                </button>
              )}
              {logic.source !== initialLogic.source && (
                <button className="dg-btn dg-btn--ghost" onClick={useExample} disabled={blocked}>
                  {logic.isExample ? 'Reset example' : 'Example'}
                </button>
              )}
              {repo && (
                <>
                  <span className="toolbar-divider" />
                  {machines.length > 0 && (
                    <select
                      className="dg-input"
                      aria-label="Indexed state machine"
                      value=""
                      disabled={blocked}
                      onChange={(e) => loadMachine(e.target.value)}
                    >
                      <option value="" disabled>
                        {machines.length} indexed state machine{machines.length === 1 ? '' : 's'}
                      </option>
                      {machines.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button className="dg-btn" onClick={buildFromRepo} disabled={blocked}>
                    {logic.isExample ? `Build from ${repo.fullName}` : 'Rebuild'}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {(busy || error || question) && (
        <p className={error ? 'notice error' : 'notice dg-data'}>
          {busy ?? error ?? `Gemini needs more detail: ${question}`}
        </p>
      )}
      {plannedChecks && !logic.managed && (
        <section className="notice" aria-label="Planned acceptance checks">
          {plannedChecks === 'fixture' ? (
            <p className="dg-data">
              Run managed agent: the agent implements the retry and is checked against the
              example&apos;s 3 retry scenarios.
            </p>
          ) : (
            <>
              <p className="dg-label">
                {logic.approved!.edits.length} approved edit
                {logic.approved!.edits.length === 1 ? '' : 's'} · the agent must pass{' '}
                {plannedChecks.length} check{plannedChecks.length === 1 ? '' : 's'}
              </p>
              <ul className="dg-data">
                {plannedChecks.map((c) => (
                  <li key={c.id}>{c.description}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {managedPending && (
        <p className="notice dg-data" role="status">
          Managed agent is editing{' '}
          {logic.approved?.repo ? logic.approved.repo.fullName : 'the example'} and testing it
          against the checks…
        </p>
      )}
      {logic.managed?.kind === 'error' && (
        <p className="notice error" role="alert">
          {logic.managed.message}
        </p>
      )}
      {managedResult && (
        <section className="notice" aria-label="Managed agent result">
          <p className="dg-label" role="status">
            {managedResult.tests.filter((test) => test.passed).length} of{' '}
            {managedResult.tests.length} acceptance checks passed
          </p>
          <ul className="dg-data">
            {managedResult.tests.map(({ id, name, passed, detail }) => (
              <li key={id ?? name}>
                {passed ? 'Pass' : 'Fail'} · {name}
                {!passed && detail && <span className="muted"> ({detail})</span>}
              </li>
            ))}
          </ul>
          {managedResult.checks === 'diagram' && managedResult.changedFiles?.length === 0 && (
            <p className="error">
              The agent changed no source files, so passing checks don&apos;t show the change was
              made.
            </p>
          )}
          {!!managedResult.changedFiles?.length && (
            <p className="dg-data">Changed: {managedResult.changedFiles.join(', ')}</p>
          )}
          <details>
            <summary>Code diff</summary>
            <pre className="dg-data managed-diff">
              {managedResult.diff || 'No changes returned.'}
            </pre>
          </details>
        </section>
      )}
      <DiagramCanvas
        diagram={diagram}
        viewKey={`${logic.version}-${proposal ? 'preview' : 'current'}`}
        canvasRef={canvasRef}
        overlay={<DrawLayer active={drawing} clearKey={clearKey} onInkChange={setHasInk} />}
        // States here are slugs of one machine; any of them stands for the catalog machine.
        componentFor={() =>
          logic.machine ? { componentId: logic.machine.id, label: logic.machine.name } : null
        }
      />
    </div>
  )
}
