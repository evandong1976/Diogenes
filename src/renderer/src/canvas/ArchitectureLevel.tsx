import { useMemo, useState } from 'react'
import type { GithubRepo } from '../../../preload'
import type { Architecture } from '../../../shared/gemini'
import type { IndexStatus } from '../../../shared/indexing'
import { DiagramCanvas } from './DiagramCanvas'
import { architectureDiagram } from './diagrams'
import { indexRunning } from './indexStatus'

type Level = 'infrastructure' | 'integrations'

interface Props {
  repo: GithubRepo
  level: Level
  architecture: Architecture | null
  onArchitectureChange(next: Architecture): void
  indexStatus: IndexStatus | null
}

function evidenceLabel(architecture: Architecture): string {
  const e = architecture.evidence
  if (e?.source === 'index') {
    return `From index ${e.sha.slice(0, 7)}${e.partial ? ' (partial)' : ''} · connections counted from code`
  }
  return 'From file list · no index yet'
}

const LEVEL_NAMES: Record<Level, string> = {
  infrastructure: 'Infrastructure',
  integrations: 'Integrations'
}

/** Infrastructure and Integrations share one Gemini call, so the result is held by the parent. */
export function ArchitectureLevel({
  repo,
  level,
  architecture,
  onArchitectureChange,
  indexStatus
}: Props): React.JSX.Element {
  const waiting = indexRunning(indexStatus)
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
          id: repo.id,
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
          {LEVEL_NAMES[level]} · {architecture ? evidenceLabel(architecture) : 'Not analyzed yet'}
        </span>
        <button className="dg-btn" onClick={analyze} disabled={busy || waiting}>
          {waiting
            ? 'Waiting for index…'
            : architecture
              ? 'Re-analyze'
              : `Analyze ${repo.fullName}`}
        </button>
      </div>
      {(busy || error) && (
        <p className={error ? 'notice error' : 'notice dg-data'}>
          {error ?? 'Grouping the repo into components…'}
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
