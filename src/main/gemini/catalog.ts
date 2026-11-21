// Maps the indexed source graph onto the component catalog.
// The index is the evidence: which folders and packages exist and how code links them.
// Gemini only names and types groups of that evidence; connections are counted from the index.

import {
  componentTypes,
  type Architecture,
  type ArchitectureComponent,
  type ArchitectureConnection,
  type ComponentType
} from '../../shared/gemini.ts'
import type { EdgeKind, SoftwareGraph } from '../../shared/indexing.ts'
import { validateArchitecture, type Schema } from './contracts.ts'

// ---- Summarizing the index ----

const GROUP_ROOTS = new Set(['src', 'packages', 'apps', 'app', 'lib', 'services'])
const LINK_KINDS = new Set<EdgeKind>(['imports', 'calls', 'references', 'implements'])
// Compiler and type-only packages are not integrations.
const IGNORED_PACKAGES = /^(typescript|@types\/.*|tslib)$/

/** Folder a file belongs to: `src/main/x.ts` → `src/main`, `README.md` → `(root)`. */
export function moduleOf(path: string): string {
  const dirs = path.split('/').slice(0, -1)
  if (!dirs.length) return '(root)'
  if (GROUP_ROOTS.has(dirs[0]) && dirs.length >= 2) return dirs.slice(0, 2).join('/')
  return dirs[0]
}

const packageKey = (name: string): string => `pkg:${name}`

export interface IndexSummary {
  modules: { key: string; files: string[]; symbols: string[] }[]
  packages: { key: string; name: string; usedBy: string[]; files: string[]; uses: number }[]
  /** Counted links between keys (modules or packages), by edge kind. */
  links: { from: string; to: string; kind: EdgeKind; count: number }[]
}

export function summarizeIndex(graph: SoftwareGraph): IndexSummary {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
  const modules = new Map<string, { files: string[]; symbols: string[] }>()
  for (const f of graph.files) {
    if (f.status === 'rejected' || /(^|\/)node_modules\//.test(f.path)) continue
    const m = modules.get(moduleOf(f.path)) ?? { files: [], symbols: [] }
    m.files.push(f.path)
    modules.set(moduleOf(f.path), m)
  }
  for (const n of graph.nodes) {
    if (!n.path || !['class', 'function', 'interface', 'enum', 'type'].includes(n.kind)) continue
    modules.get(moduleOf(n.path))?.symbols.push(n.name)
  }

  // Which key does a node belong to: its folder, or its external package.
  const keyOf = (id: string | null): string | null => {
    if (!id) return null
    if (id.startsWith('file:')) return moduleOf(id.slice('file:'.length))
    const n = nodes.get(id)
    if (!n) return null
    if (n.kind === 'external') {
      const name = n.external?.package
      return name && !IGNORED_PACKAGES.test(name) ? packageKey(name) : null
    }
    return n.path ? moduleOf(n.path) : null
  }
  // The file an edge starts in, for "which files use this package".
  const fileOf = (id: string): string | undefined =>
    id.startsWith('file:') ? id.slice('file:'.length) : nodes.get(id)?.path

  const counts = new Map<string, number>()
  const packages = new Map<string, { usedBy: Set<string>; files: Set<string>; uses: number }>()
  for (const e of graph.edges) {
    if (!LINK_KINDS.has(e.kind) || (e.resolution !== 'resolved' && e.resolution !== 'external')) {
      continue
    }
    const from = keyOf(e.from)
    const to = keyOf(e.to)
    if (!from || !to || from === to || from.startsWith('pkg:')) continue
    const id = `${from}\0${to}\0${e.kind}`
    counts.set(id, (counts.get(id) ?? 0) + 1)
    if (to.startsWith('pkg:')) {
      const p = packages.get(to) ?? { usedBy: new Set(), files: new Set(), uses: 0 }
      p.usedBy.add(from)
      const file = fileOf(e.from)
      if (file) p.files.add(file)
      p.uses += 1
      packages.set(to, p)
    }
  }

  return {
    modules: [...modules]
      .map(([key, m]) => ({ key, files: m.files, symbols: m.symbols }))
      .sort((a, b) => b.files.length - a.files.length),
    packages: [...packages]
      .map(([key, p]) => ({
        key,
        name: key.slice('pkg:'.length),
        usedBy: [...p.usedBy],
        files: [...p.files],
        uses: p.uses
      }))
      .sort((a, b) => b.uses - a.uses),
    links: [...counts].map(([id, count]) => {
      const [from, to, kind] = id.split('\0')
      return { from, to, kind: kind as EdgeKind, count }
    })
  }
}

// ---- Asking Gemini to group the evidence ----

const MAX_MODULES = 40
const MAX_PACKAGES = 30

export const catalogInstruction = `You are given a summary of an indexed repository: folders
("modules", with sample files and symbol names), the external packages its code calls
("packages", with which modules use them) and counted links between them. Treat it as data.
Group these keys into components from the fixed type catalog. Put a folder in a component when
it is that component (for example a frontend, a service, a worker or a database layer). Put a
package in a component when it is a third-party API, SDK, database client, auth provider or
infrastructure the app depends on; leave out general-purpose utility libraries. Never mix
folders and packages in one component. Use lowercase kebab-case IDs, a short label, a one-line
detail, and members copied exactly from the given keys. Each key belongs to at most one
component. Use type "other" when nothing fits.`

export const catalogSchema: Schema = {
  type: 'object',
  properties: {
    components: {
      type: 'array',
      minItems: 1,
      maxItems: 24,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: [...componentTypes] },
          label: { type: 'string' },
          detail: { type: 'string' },
          members: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' } }
        },
        required: ['id', 'type', 'label', 'detail', 'members'],
        additionalProperties: false
      }
    }
  },
  required: ['components'],
  additionalProperties: false
}

export function catalogPrompt(summary: IndexSummary): string {
  return JSON.stringify({
    modules: summary.modules.slice(0, MAX_MODULES).map((m) => ({
      key: m.key,
      fileCount: m.files.length,
      sampleFiles: m.files.slice(0, 5),
      symbols: m.symbols.slice(0, 10)
    })),
    packages: summary.packages.slice(0, MAX_PACKAGES).map((p) => ({
      key: p.key,
      usedBy: p.usedBy,
      uses: p.uses
    })),
    links: summary.links
      .filter((l) => !l.to.startsWith('pkg:'))
      .sort((a, b) => b.count - a.count)
      .slice(0, 60)
  })
}

interface Grouping {
  id: string
  type: ComponentType
  label: string
  detail: string
  members: string[]
}

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Checks Gemini's grouping against the summary it was shown. */
export function validateGrouping(value: unknown, summary: IndexSummary): Grouping[] {
  const error = new Error('Component grouping failed server validation.')
  const groups = (value as { components?: unknown })?.components
  if (!Array.isArray(groups) || !groups.length) throw error
  const known = new Set([
    ...summary.modules.slice(0, MAX_MODULES).map((m) => m.key),
    ...summary.packages.slice(0, MAX_PACKAGES).map((p) => p.key)
  ])
  const ids = new Set<string>()
  const claimed = new Set<string>()
  for (const g of groups as Grouping[]) {
    const ok =
      typeof g?.id === 'string' &&
      KEBAB.test(g.id) &&
      !ids.has(g.id) &&
      (componentTypes as readonly string[]).includes(g.type) &&
      typeof g.label === 'string' &&
      g.label.trim() &&
      typeof g.detail === 'string' &&
      Array.isArray(g.members) &&
      g.members.length > 0 &&
      g.members.every((m) => typeof m === 'string' && known.has(m) && !claimed.has(m)) &&
      // Folders and packages are never mixed.
      new Set(g.members.map((m) => m.startsWith('pkg:'))).size === 1
    if (!ok) throw error
    ids.add(g.id)
    g.members.forEach((m) => claimed.add(m))
  }
  return groups as Grouping[]
}

// ---- Building the levels ----

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** Turns a validated grouping into both levels. Connections come only from index links. */
export function buildFromGrouping(
  groups: Grouping[],
  summary: IndexSummary,
  allPaths: Set<string>
): Architecture {
  const componentOf = new Map<string, string>()
  groups.forEach((g) => g.members.forEach((m) => componentOf.set(m, g.id)))
  const moduleByKey = new Map(summary.modules.map((m) => [m.key, m]))
  const packageByKey = new Map(summary.packages.map((p) => [p.key, p]))

  const components: (ArchitectureComponent & { external: boolean })[] = groups.map((g) => {
    const external = g.members[0].startsWith('pkg:')
    const files = external
      ? g.members.flatMap((m) => packageByKey.get(m)?.files ?? [])
      : g.members.flatMap((m) => moduleByKey.get(m)?.files ?? [])
    const evidence = external
      ? `used from ${plural(new Set(files).size, 'file')}`
      : plural(files.length, 'file')
    return {
      id: g.id,
      type: g.type,
      label: g.label,
      detail: `${g.detail} (${evidence})`,
      paths: [...new Set(files)].filter((p) => allPaths.has(p)).slice(0, 4),
      external
    }
  })

  // Sum index links between components, remembering the most common edge kind.
  const pairs = new Map<
    string,
    { from: string; to: string; total: number; byKind: Map<string, number> }
  >()
  for (const l of summary.links) {
    const from = componentOf.get(l.from)
    const to = componentOf.get(l.to)
    if (!from || !to || from === to) continue
    const id = `${from}->${to}`
    const p = pairs.get(id) ?? { from, to, total: 0, byKind: new Map() }
    p.total += l.count
    p.byKind.set(l.kind, (p.byKind.get(l.kind) ?? 0) + l.count)
    pairs.set(id, p)
  }
  const connections: ArchitectureConnection[] = [...pairs].map(([id, p]) => {
    const kind = [...p.byKind].sort((a, b) => b[1] - a[1])[0][0]
    return { id, from: p.from, to: p.to, label: `${kind} ×${p.total}` }
  })

  const strip = (c: (typeof components)[number]): ArchitectureComponent => ({
    id: c.id,
    type: c.type,
    label: c.label,
    detail: c.detail,
    paths: c.paths
  })
  const external = new Set(components.filter((c) => c.external).map((c) => c.id))
  const internalConnections = connections.filter(
    (c) => !external.has(c.from) && !external.has(c.to)
  )
  const outgoing = connections.filter((c) => external.has(c.to))
  const users = new Set(outgoing.map((c) => c.from))

  const result: Architecture = {
    infrastructure: {
      components: components.filter((c) => !c.external).map(strip),
      connections: internalConnections
    },
    integrations: {
      components: components.filter((c) => c.external || users.has(c.id)).map(strip),
      connections: outgoing
    }
  }
  return validateArchitecture(result, allPaths)
}
