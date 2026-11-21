import { useMemo, useState } from 'react'
import type { GithubRepo } from '../../../preload'
import type { Architecture } from '../../../shared/gemini'
import { DiagramCanvas } from './DiagramCanvas'
import { architectureDiagram } from './diagrams'

interface Props {
  repo: GithubRepo
  level: keyof Architecture
  architecture: Architecture | null
  onArchitectureChange(next: Architecture): void
}

const LEVEL_NAMES: Record<keyof Architecture, string> = {
  infrastructure: 'Infrastructure',
  integrations: 'Integrations'
}

/** Infrastructure and Integrations share one Gemini call, so the result is held by the parent. */
export function ArchitectureLevel({
  repo,
  level,
  architecture,
  onArchitectureChange
}: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  const diagram = useMemo(
    () => architecture && architectureDiagram(architecture[level]),
    [architecture, level]
  )

  const analyze = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      onArchitectureChange(
        await window.api.gemini.buildArchitecture({
          fullName: repo.fullName,
          branch: repo.defaultBranch
        })
      )
      setVersion((v) => v + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="level">
      <div className="toolbar row">
        <span className="dg-label">
          {LEVEL_NAMES[level]} · {architecture ? repo.fullName : 'Not analyzed yet'}
        </span>
        <button className="dg-btn" onClick={analyze} disabled={busy}>
          {architecture ? 'Re-analyze' : `Analyze ${repo.fullName}`}
        </button>
      </div>
      {(busy || error) && (
        <p className={error ? 'notice error' : 'notice dg-data'}>
          {error ?? 'Reading file list and manifests…'}
        </p>
      )}
      {diagram ? (
        <DiagramCanvas diagram={diagram} viewKey={`${level}-${version}`} />
      ) : (
        <div className="dg-canvas canvas-empty level-empty">
          <span className="dg-label">Analyze the repo to see its {LEVEL_NAMES[level]}</span>
        </div>
      )}
    </div>
  )
}
