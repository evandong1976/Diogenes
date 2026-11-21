import { useMemo, useRef, useState } from 'react'
import type { GithubRepo } from '../../../preload'
import type { ProposedEdit } from '../../../shared/gemini'
import { applyEdit } from '../../../shared/graph'
import { DiagramCanvas } from './DiagramCanvas'
import { DrawLayer } from './DrawLayer'
import { stateDiagram } from './diagrams'
import { exampleEdit, initialLogic, type LogicState } from './logic'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface Props {
  repo: GithubRepo | null
  logic: LogicState
  onLogicChange: React.Dispatch<React.SetStateAction<LogicState>>
}

export function CodeLogicLevel({ repo, logic, onLogicChange }: Props): React.JSX.Element {
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

  const buildFromRepo = (): Promise<void> =>
    run('Reading repo…', async () => {
      if (!repo) return
      const { graph, files } = await window.api.gemini.buildRepoGraph({
        fullName: repo.fullName,
        branch: repo.defaultBranch
      })
      reset()
      onLogicChange({
        graph,
        source: `${repo.fullName} · ${files.length} file${files.length === 1 ? '' : 's'} read`,
        isExample: false,
        version: logic.version + 1
      })
    })

  const useExample = (): Promise<void> =>
    run('Loading example…', async () => {
      await window.api.gemini.useFixture()
      reset()
      onLogicChange({ ...initialLogic, version: logic.version + 1 })
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
      const result = await window.api.gemini.proposeEdit(logic.graph, png)
      setDrawing(false)
      if (result.kind === 'edit') {
        setProposal(result)
        setQuestion(null)
      } else {
        setProposal(null)
        setQuestion(result.question)
      }
    })

  const approve = (): void => {
    if (!proposal) return
    onLogicChange({
      graph: applyEdit(logic.graph, proposal),
      source: logic.source.endsWith('· edited') ? logic.source : `${logic.source} · edited`,
      isExample: logic.isExample,
      approved:
        logic.isExample && logic.source === initialLogic.source
          ? { graph: logic.graph, edit: proposal }
          : undefined,
      version: logic.version + 1
    })
    reset()
  }

  const runManaged = async (): Promise<void> => {
    const approved = logic.approved
    if (!approved || managedPending) return
    onLogicChange({ ...logic, managed: { kind: 'running' } })

    try {
      const result = await window.api.gemini.runManagedRetry(approved.graph, approved.edit)
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
      {managedPending && (
        <p className="notice dg-data" role="status">
          Managed agent is editing and testing the example…
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
            {managedResult.tests.map(({ name, passed }) => (
              <li key={name}>
                {passed ? 'Pass' : 'Fail'} · {name}
              </li>
            ))}
          </ul>
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
      />
    </div>
  )
}
