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
  repo: GithubRepo
  logic: LogicState
  onLogicChange(next: LogicState): void
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
      version: logic.version + 1
    })
    reset()
  }

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
                onClick={() => setDrawing((d) => !d)}
              >
                {drawing ? 'Drawing' : 'Draw'}
              </button>
              {hasInk && (
                <button className="dg-btn dg-btn--ghost" onClick={() => setClearKey((k) => k + 1)}>
                  Clear
                </button>
              )}
              <button className="dg-btn" onClick={propose} disabled={!hasInk || !!busy}>
                Propose change
              </button>
              {logic.isExample && logic.source === initialLogic.source && (
                <button className="dg-btn dg-btn--ghost" onClick={() => setProposal(exampleEdit)}>
                  Saved proposal
                </button>
              )}
              <span className="toolbar-divider" />
              {logic.isExample ? (
                <button className="dg-btn" onClick={buildFromRepo} disabled={!!busy}>
                  Build from {repo.fullName}
                </button>
              ) : (
                <>
                  <button className="dg-btn dg-btn--ghost" onClick={useExample}>
                    Example
                  </button>
                  <button className="dg-btn" onClick={buildFromRepo} disabled={!!busy}>
                    Rebuild
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
      <DiagramCanvas
        diagram={diagram}
        viewKey={`${logic.version}-${proposal ? 'preview' : 'current'}`}
        canvasRef={canvasRef}
        overlay={<DrawLayer active={drawing} clearKey={clearKey} onInkChange={setHasInk} />}
      />
    </div>
  )
}
