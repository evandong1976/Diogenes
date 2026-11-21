import { useState } from 'react'
import type { CurrentGraph, ProposedEdit } from '../../../shared/gemini'
import example from '../../../../fixtures/background-job/example.json'
import { GraphCanvas } from './GraphCanvas'

// Saved Gemini responses, so the canvas works without an API key.
const exampleGraph = example.currentGraph as CurrentGraph
const exampleEdit = example.proposedEdit as ProposedEdit

export function CodeLogicLevel(): React.JSX.Element {
  const [graph, setGraph] = useState<CurrentGraph>(exampleGraph)
  const [source, setSource] = useState<'example' | 'gemini'>('example')
  const [showPreview, setShowPreview] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rebuild = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setGraph(await window.api.gemini.buildCurrentGraph())
      setSource('gemini')
      setShowPreview(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="level">
      <div className="toolbar row">
        <span className="muted">
          Background job · {source === 'example' ? 'saved example' : 'built by Gemini'}
        </span>
        <div className="row" style={{ gap: 8 }}>
          {source === 'example' && (
            <button aria-pressed={showPreview} onClick={() => setShowPreview((v) => !v)}>
              Preview “retry once” edit
            </button>
          )}
          <button onClick={rebuild} disabled={loading}>
            {loading ? 'Building…' : 'Rebuild with Gemini'}
          </button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <GraphCanvas graph={graph} preview={showPreview ? exampleEdit : null} />
    </div>
  )
}
