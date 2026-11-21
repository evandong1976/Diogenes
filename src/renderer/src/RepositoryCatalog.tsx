import { useEffect, useState } from 'react'
import type {
  CatalogGraph,
  CatalogKind,
  CatalogNode,
  CatalogOperation,
  CatalogSource
} from '../../shared/catalog'
import type { IndexStatus, SoftwareGraph } from '../../shared/indexing'

const kindsByLevel: CatalogKind[][] = [
  ['module', 'workload', 'resource'],
  ['operation', 'view', 'trigger', 'workflow'],
  ['stateMachine', 'dataContract', 'generic']
]

const labels: Record<CatalogKind, string> = {
  module: 'Module',
  workload: 'Workload',
  operation: 'Operation',
  resource: 'Resource',
  dataContract: 'Data contract',
  stateMachine: 'State machine',
  view: 'View',
  trigger: 'Trigger',
  workflow: 'Workflow',
  generic: 'Component'
}

function SourceLinks({
  graph,
  sources
}: {
  graph: CatalogGraph
  sources: CatalogSource[]
}): React.JSX.Element | null {
  if (sources.length === 0) return null
  const repo = graph.repository.fullName.split('/').map(encodeURIComponent).join('/')
  return (
    <ul aria-label="Source bindings">
      {sources.map((source, i) => {
        const line = source.span ? source.span.start.line + 1 : undefined
        const path = source.path.split('/').map(encodeURIComponent).join('/')
        const url = `https://github.com/${repo}/blob/${graph.commit.sha}/${path}${line ? `#L${line}` : ''}`
        return (
          <li className="dg-data" key={i}>
            <a href={url} target="_blank" rel="noreferrer">
              {source.path}
              {line ? ':' + line : ''}
            </a>
          </li>
        )
      })}
    </ul>
  )
}

export function RepositoryCatalog({
  repoId,
  level
}: {
  repoId: number
  level: number
}): React.JSX.Element {
  const [status, setStatus] = useState<IndexStatus>()
  const [snapshot, setSnapshot] = useState<SoftwareGraph | null>(null)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [name, setName] = useState('')
  const [proposedKind, setProposedKind] = useState<CatalogKind>()
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(60)
  const [preview, setPreview] = useState<{
    graph: CatalogGraph
    operations: CatalogOperation[]
    catalog: CatalogGraph
  }>()

  useEffect(() => {
    let active = true
    let request = 0
    let receivedStatus = false
    const failed = (cause: unknown): void => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause))
    }
    const load = (): void => {
      const latest = ++request
      void window.api.indexing.getGraph(repoId).then((graph) => {
        if (active && latest === request) setSnapshot(graph)
      }, failed)
    }
    const handle = (next: IndexStatus): void => {
      if (!active || next.repoId !== repoId) return
      receivedStatus = true
      setStatus(next)
      if (next.state === 'complete' || next.state === 'partial') load()
    }
    const unsubscribe = window.api.indexing.onStatus(handle)
    void window.api.indexing.getStatus(repoId).then((next) => {
      if (!active || receivedStatus) return
      setStatus(next)
      load()
    }, failed)
    return () => {
      active = false
      unsubscribe()
    }
  }, [repoId])

  const catalog = snapshot?.catalog
  const draft = preview?.catalog === catalog ? preview : undefined
  const shown = draft?.graph ?? catalog
  const kinds = kindsByLevel[level] ?? kindsByLevel[0]
  const kind = proposedKind && kinds.includes(proposedKind) ? proposedKind : kinds[0]
  const matches =
    shown?.nodes.filter(
      (node) => kinds.includes(node.kind) && node.name.toLowerCase().includes(query.toLowerCase())
    ) ?? []
  const selected = shown?.nodes.find((node) => node.id === selectedId)
  const links =
    shown?.edges.filter(
      (edge) => edge.from.nodeId === selectedId || edge.to.nodeId === selectedId
    ) ?? []

  async function index(force: boolean): Promise<void> {
    setError('')
    setStarting(true)
    try {
      const run = force ? window.api.indexing.retry : window.api.indexing.start
      const next = await run(repoId)
      setStatus((current) => current ?? next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStarting(false)
    }
  }

  async function previewEdit(operation: CatalogOperation): Promise<void> {
    if (!catalog) return
    setError('')
    setChecking(true)
    const operations = [...(draft?.operations ?? []), operation]
    try {
      const result = await window.api.catalog.preview({
        repositoryId: repoId,
        commitSha: catalog.commit.sha,
        baseRevision: catalog.revision,
        operations
      })
      if (!result.ok) {
        setError(result.issue.message)
        return
      }
      setPreview({ graph: result.graph, operations, catalog })
      if (operation.type === 'create') setSelectedId(operation.node.id)
      setName('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setChecking(false)
    }
  }

  function addComponent(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!name.trim()) return
    const base = {
      id: 'proposed:' + crypto.randomUUID(),
      name: name.trim(),
      properties: {},
      ports: [],
      sources: [],
      resolution: 'proposed' as const
    }
    const node: CatalogNode = { ...base, kind }
    void previewEdit({ type: 'create', node })
  }

  const busy = starting || status?.state === 'running'
  const force = Boolean(status?.lastIndexed || status?.state === 'failed')

  return (
    <main className="dg-canvas repository-catalog">
      <div className="row catalog-toolbar">
        <div>
          <h1 className="title">Repository catalog</h1>
          <p className="dg-data" role="status">
            {busy
              ? 'Indexing ' + (status?.stage ?? 'repository') + '…'
              : catalog
                ? catalog.commit.sha.slice(0, 7) + ' · ' + catalog.nodes.length + ' components'
                : snapshot
                  ? 'Refresh the index to build the catalog.'
                  : 'Index the repository to discover components.'}
          </p>
        </div>
        <button
          className="dg-btn dg-btn--primary"
          disabled={busy || checking}
          onClick={() => void index(force)}
        >
          {force ? 'Reindex' : 'Index repository'}
        </button>
      </div>
      {(error || status?.error) && (
        <p className="error catalog-message" role="alert">
          {error || status?.error}
        </p>
      )}
      {snapshot?.status === 'partial' && (
        <p className="muted catalog-message">
          Partial index · {snapshot.coverage.analyzedFiles} of {snapshot.coverage.sourceFiles}{' '}
          supported source files analyzed
        </p>
      )}
      {shown && (
        <div className="catalog-body">
          <section aria-label="Components" className="catalog-list">
            <input
              className="dg-input"
              type="search"
              aria-label="Filter components"
              placeholder="Filter components"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setLimit(60)
              }}
            />
            {matches.length === 0 && <p className="muted">No components at this level.</p>}
            <ul>
              {matches.slice(0, limit).map((node) => (
                <li key={node.id}>
                  <button
                    className="dg-node catalog-node"
                    data-selected={node.id === selectedId}
                    data-proposed={node.resolution === 'proposed'}
                    onClick={() => setSelectedId(node.id)}
                  >
                    <span>{node.name}</span>
                    <span className="dg-label">{labels[node.kind]}</span>
                  </button>
                </li>
              ))}
            </ul>
            {matches.length > limit && (
              <button className="dg-btn" onClick={() => setLimit(limit + 60)}>
                Show more
              </button>
            )}
          </section>
          <section aria-label="Component details" className="catalog-detail">
            <form className="catalog-create" onSubmit={addComponent}>
              <select
                className="dg-input"
                aria-label="Component type"
                value={kind}
                onChange={(event) =>
                  setProposedKind(kinds.find((value) => value === event.target.value))
                }
              >
                {kinds.map((value) => (
                  <option key={value} value={value}>
                    {labels[value]}
                  </option>
                ))}
              </select>
              <div className="row">
                <input
                  className="dg-input"
                  aria-label="Proposed component name"
                  placeholder={'New ' + labels[kind].toLowerCase()}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <button className="dg-btn" disabled={!name.trim() || checking || busy}>
                  Preview add
                </button>
              </div>
            </form>
            {draft && (
              <div className="row">
                <span className="dg-data" role="status">
                  {draft.operations.length} proposed edits
                </span>
                <button
                  className="dg-btn dg-btn--ghost"
                  disabled={checking}
                  onClick={() => setPreview(undefined)}
                >
                  Clear preview
                </button>
              </div>
            )}
            {selected ? (
              <>
                <h2 className="title">{selected.name}</h2>
                <p className="dg-data">
                  {labels[selected.kind]} · {selected.resolution}
                </p>
                <SourceLinks graph={shown} sources={selected.sources} />
                {links.length > 0 && (
                  <ul aria-label="Connections">
                    {links.map((edge) => {
                      const other =
                        edge.from.nodeId === selectedId ? edge.to.nodeId : edge.from.nodeId
                      const label = shown.nodes.find((node) => node.id === other)?.name ?? other
                      return (
                        <li key={edge.id}>
                          <details>
                            <summary>
                              {edge.kind.replaceAll('_', ' ')} · {label}
                            </summary>
                            <SourceLinks graph={shown} sources={edge.sources} />
                            <div className="row">
                              <button
                                className="dg-btn dg-btn--ghost"
                                onClick={() => setSelectedId(other)}
                              >
                                Inspect component
                              </button>
                              <button
                                className="dg-btn dg-btn--ghost"
                                disabled={busy || checking}
                                onClick={() =>
                                  void previewEdit({ type: 'disconnect', edgeId: edge.id })
                                }
                              >
                                Preview unlink
                              </button>
                            </div>
                          </details>
                        </li>
                      )
                    })}
                  </ul>
                )}
                <button
                  className="dg-btn dg-btn--danger"
                  disabled={busy || checking}
                  onClick={() => void previewEdit({ type: 'delete', nodeId: selected.id })}
                >
                  Preview deletion
                </button>
              </>
            ) : (
              <p className="muted">Select a component to inspect its source and connections.</p>
            )}
          </section>
        </div>
      )}
    </main>
  )
}
