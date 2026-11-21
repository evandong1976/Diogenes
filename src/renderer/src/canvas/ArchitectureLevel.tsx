import { useMemo, useState } from 'react'
import type { GithubRepo } from '../../../preload'
import type { CatalogGraph } from '../../../shared/catalog'
import type { Architecture } from '../../../shared/gemini'
import type { IndexStatus } from '../../../shared/indexing'
import { DiagramCanvas } from './DiagramCanvas'
import { architectureDiagram, catalogDiagram, catalogKindsByLevel } from './diagrams'
import { indexRunning } from './indexStatus'

type Level = 'infrastructure' | 'integrations'

interface Props {
  repo: GithubRepo
  level: Level
  /** The indexed catalog. When present it is drawn directly; Gemini is only the fallback. */
  catalog: CatalogGraph | null
  architecture: Architecture | null
  onArchitectureChange(next: Architecture): void
  indexStatus: IndexStatus | null
}

const LEVEL_NAMES: Record<Level, string> = {
  infrastructure: 'Infrastructure',
  integrations: 'Integrations'
}

export function ArchitectureLevel({
  repo,
  level,
  catalog,
  architecture,
  onArchitectureChange,
  indexStatus
}: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const waiting = indexRunning(indexStatus)

  const fromCatalog = useMemo(
    () => catalog && catalogDiagram(catalog, catalogKindsByLevel[level]),
    [catalog, level]
  )
  const fromFiles = useMemo(
    () => architecture && architectureDiagram(architecture[level]),
    [architecture, level]
  )
  // The index wins whenever it has something for this level.
  const useCatalog = !!fromCatalog?.nodes.length
  const diagram = useCatalog ? fromCatalog : fromFiles

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

  const source = useCatalog
    ? `From index ${catalog!.commit.sha.slice(0, 7)} · ${fromCatalog!.nodes.length} catalog nodes`
    : architecture
      ? 'Inferred by Gemini from the file list'
      : waiting
        ? 'Indexing…'
        : catalog
          ? 'Index has nothing at this level'
          : 'Not indexed'

  return (
    <div className="level">
      <div className="toolbar row">
        <span className="dg-label">
          {LEVEL_NAMES[level]} · {source}
        </span>
        {!useCatalog && (
          <button className="dg-btn" onClick={analyze} disabled={busy || waiting}>
            {waiting
              ? 'Waiting for index…'
              : architecture
                ? 'Re-infer with Gemini'
                : 'Infer with Gemini'}
          </button>
        )}
      </div>
      {(busy || error) && (
        <p className={error ? 'notice error' : 'notice dg-data'}>
          {error ?? 'Reading the file list and manifests…'}
        </p>
      )}
      {diagram ? (
        <DiagramCanvas
          diagram={diagram}
          viewKey={`${level}-${useCatalog ? catalog!.commit.sha : version}`}
        />
      ) : (
        <div className="dg-canvas--dots canvas-empty level-empty">
          <span className="dg-label">
            {waiting
              ? `Indexing ${repo.fullName}…`
              : `No ${LEVEL_NAMES[level]} yet. Index the repo, or infer it with Gemini.`}
          </span>
        </div>
      )}
    </div>
  )
}
