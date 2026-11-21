import { useEffect, useMemo, useState } from 'react'
import type { GithubRepo } from '../../preload'
import type { SoftwareGraph } from '../../shared/indexing'
import { DRAG_FILE, LEVELS } from './canvas/components'

interface Props {
  repo: GithubRepo | null
  onPickRepo(repo: GithubRepo): void
  /** Back to the repo picker (or sign-in, in example mode). */
  onConnectRepo(): void
  level: number
  onLevel(level: number): void
  /** Component counts per level, when the index has them. */
  levelCounts: (number | null)[]
  view: 'canvas' | 'catalog'
  onView(view: 'canvas' | 'catalog'): void
  indexed: SoftwareGraph | null
  indexLabel: string
  /** Components per file path, so the tree shows which files are on the canvas. */
  fileCounts: Map<string, number>
  focusFile: string | null
  onFocusFile(path: string | null): void
}

export function Sidebar(props: Props): React.JSX.Element {
  const { repo, level, view } = props
  return (
    <aside className="sidebar" aria-label="Workspace">
      <RepoSection repo={repo} onPick={props.onPickRepo} onConnect={props.onConnectRepo} />

      <section className="sidebar__section">
        <h2 className="dg-label sidebar__head">Levels</h2>
        <ul>
          {LEVELS.map((l, i) => (
            <li key={l.name}>
              <button
                className="sidebar__row"
                aria-current={level === i && view === 'canvas' ? 'true' : undefined}
                disabled={!repo && i !== 2}
                onClick={() => {
                  props.onLevel(i)
                  props.onView('canvas')
                }}
              >
                <span className="sidebar__name">{l.name}</span>
                {props.levelCounts[i] !== null && (
                  <span className="dg-data">{props.levelCounts[i]}</span>
                )}
              </button>
            </li>
          ))}
          {repo && (
            <li>
              <button
                className="sidebar__row"
                aria-current={view === 'catalog' ? 'true' : undefined}
                onClick={() => props.onView('catalog')}
              >
                <span className="sidebar__name">Catalog</span>
                <span className="dg-data">list</span>
              </button>
            </li>
          )}
        </ul>
      </section>

      <section className="sidebar__section sidebar__files">
        <h2 className="dg-label sidebar__head">
          Files
          {props.focusFile && (
            <button className="link-x" onClick={() => props.onFocusFile(null)}>
              Clear
            </button>
          )}
        </h2>
        {props.indexed ? (
          <FileTree
            paths={props.indexed.files.filter((f) => f.status !== 'rejected').map((f) => f.path)}
            counts={props.fileCounts}
            focus={props.focusFile}
            onFocus={props.onFocusFile}
          />
        ) : (
          <p className="dg-data sidebar__note">
            {repo ? props.indexLabel : 'Bundled example has no files'}
          </p>
        )}
      </section>
    </aside>
  )
}

function RepoSection({
  repo,
  onPick,
  onConnect
}: {
  repo: GithubRepo | null
  onPick(repo: GithubRepo): void
  onConnect(): void
}): React.JSX.Element {
  const [others, setOthers] = useState<GithubRepo[]>([])
  useEffect(() => {
    if (!repo) return
    window.api.github.listRepos().then(
      (all) => setOthers(all.filter((r) => r.id !== repo.id).slice(0, 4)),
      () => setOthers([])
    )
  }, [repo])

  return (
    <section className="sidebar__section">
      <h2 className="dg-label sidebar__head">Repository</h2>
      <ul>
        {repo ? (
          <li>
            <div className="sidebar__row" aria-current="true">
              <span className="sidebar__swatch" data-active />
              <strong className="sidebar__name">{repo.fullName}</strong>
              <span className="dg-label">{repo.defaultBranch}</span>
            </div>
          </li>
        ) : (
          <li>
            <div className="sidebar__row" aria-current="true">
              <strong className="sidebar__name">Bundled example</strong>
            </div>
          </li>
        )}
        {others.map((r) => (
          <li key={r.id}>
            <button className="sidebar__row" onClick={() => onPick(r)}>
              <span className="sidebar__swatch" />
              <span className="sidebar__name">{r.fullName}</span>
            </button>
          </li>
        ))}
        <li>
          <button className="sidebar__row sidebar__row--quiet" onClick={onConnect}>
            {repo ? '+ Connect repo' : '← Back to sign in'}
          </button>
        </li>
      </ul>
    </section>
  )
}

/** Design threads: create, switch and reopen. Opening one also shows the chat pane. */
type Dir = { name: string; path: string; dirs: Map<string, Dir>; files: string[] }

function buildTree(paths: string[]): Dir {
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [] }
  for (const p of paths) {
    const parts = p.split('/')
    let dir = root
    for (const part of parts.slice(0, -1)) {
      const path = dir.path ? `${dir.path}/${part}` : part
      if (!dir.dirs.has(part)) dir.dirs.set(part, { name: part, path, dirs: new Map(), files: [] })
      dir = dir.dirs.get(part)!
    }
    dir.files.push(p)
  }
  return root
}

/** Components under a folder, so collapsed folders still show where the canvas points. */
function folderCount(dir: Dir, counts: Map<string, number>): number {
  let n = dir.files.reduce((sum, f) => sum + (counts.get(f) ?? 0), 0)
  for (const d of dir.dirs.values()) n += folderCount(d, counts)
  return n
}

function FileTree({
  paths,
  counts,
  focus,
  onFocus
}: {
  paths: string[]
  counts: Map<string, number>
  focus: string | null
  onFocus(path: string | null): void
}): React.JSX.Element {
  const tree = useMemo(() => buildTree(paths), [paths])
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (path: string): void =>
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const render = (dir: Dir, depth: number): React.JSX.Element[] => [
    ...[...dir.dirs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => {
        const count = folderCount(d, counts)
        return (
          <li key={d.path}>
            <button
              className="tree__row"
              style={{ '--depth': depth } as React.CSSProperties}
              aria-expanded={open.has(d.path)}
              onClick={() => toggle(d.path)}
            >
              <span className="tree__chevron">{open.has(d.path) ? '▾' : '▸'}</span>
              <span className="tree__name">{d.name}</span>
              {count > 0 && <span className="tree__count">{count}</span>}
            </button>
            {open.has(d.path) && <ul>{render(d, depth + 1)}</ul>}
          </li>
        )
      }),
    ...dir.files
      .slice()
      .sort()
      .map((f) => {
        const count = counts.get(f) ?? 0
        return (
          <li key={f}>
            <button
              className="tree__row tree__file"
              style={{ '--depth': depth } as React.CSSProperties}
              aria-current={focus === f ? 'true' : undefined}
              draggable
              title={`${f}\nClick to highlight its components. Drag onto a component to link it.`}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_FILE, f)
                e.dataTransfer.effectAllowed = 'link'
              }}
              onClick={() => onFocus(focus === f ? null : f)}
            >
              <span className="tree__name">{f.split('/').slice(-1)[0]}</span>
              {count > 0 && <span className="tree__count">{count}</span>}
            </button>
          </li>
        )
      })
  ]

  return <ul className="tree">{render(tree, 0)}</ul>
}
