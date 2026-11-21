// L2 Integrations: what the repo talks to, from the index.
// Catalog operations (IPC/HTTP handlers) and their call edges come from discovery. External
// packages come from the indexed import and call edges: indexing never installs dependencies, so
// a package import is an unresolved edge whose target text is the module specifier.

import type { CatalogGraph } from '../../../shared/catalog'
import type { GraphEdge, SoftwareGraph } from '../../../shared/indexing'
import {
  catalogDiagram,
  catalogKindsByLevel,
  type Diagram,
  type DiagramEdge,
  type DiagramNode,
  type DiagramSource,
  type PortType
} from './diagrams'

export type PackageCategory = 'api' | 'auth' | 'database' | 'messaging' | 'library'

// Checked in order; the first match wins. Anything unmatched is a general library.
const CATEGORY_RULES: [PackageCategory, RegExp][] = [
  [
    'auth',
    /^(@clerk\/|@auth\/|next-auth$|passport|jsonwebtoken$|jose$|@supabase\/auth|@okta\/|auth0|@azure\/msal|firebase-admin\/auth|@kinde)/
  ],
  [
    'database',
    /^(@prisma\/client$|prisma$|pg$|postgres$|mysql2?$|mongodb$|mongoose$|redis$|ioredis$|@upstash\/|drizzle-orm|knex$|sequelize$|typeorm$|better-sqlite3$|sqlite3?$|@supabase\/supabase-js$|@neondatabase\/|@planetscale\/|firebase|@google-cloud\/firestore|@aws-sdk\/client-dynamodb|kysely$)/
  ],
  [
    'messaging',
    /^(kafkajs$|amqplib$|bullmq?$|bee-queue$|@aws-sdk\/client-(sqs|sns|eventbridge)|socket\.io|ws$|nats$|@google-cloud\/pubsub|pusher|ably$|@temporalio\/|inngest$)/
  ],
  [
    'api',
    /^(axios$|got$|ky$|node-fetch$|undici$|stripe$|openai$|@anthropic-ai\/|@google\/(genai|generative-ai)|@octokit\/|octokit$|twilio$|@sendgrid\/|resend$|@slack\/|discord\.js$|@aws-sdk\/|aws-sdk$|@google-cloud\/|@vercel\/|@sentry\/|posthog|@linear\/|@notionhq\/|graphql-request$|@apollo\/client$|@trpc\/client$|replicate$|cohere-ai$|@mistralai\/|groq-sdk$)/
  ]
]

const CATEGORY_LABEL: Record<PackageCategory, string> = {
  api: 'External API',
  auth: 'Auth',
  database: 'Database',
  messaging: 'Messaging',
  library: 'Library'
}

const CATEGORY_PORT: Record<PackageCategory, PortType> = {
  api: 'http',
  auth: 'auth',
  database: 'data',
  messaging: 'event',
  library: 'data'
}

// Compiler and type-only packages never count as integrations.
const IGNORED = /^(typescript|tslib|@types\/.*)$/

export function categorize(name: string): PackageCategory {
  return CATEGORY_RULES.find(([, rule]) => rule.test(name))?.[0] ?? 'library'
}

/** `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. Null for relative and Node paths. */
export function packageOf(specifier: string): string | null {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null
  if (specifier.startsWith('node:')) return null
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

export interface PackageUse {
  name: string
  category: PackageCategory
  /** Catalog module node ID → files importing it and call sites into it. */
  users: Map<string, { files: Set<string>; calls: number }>
  sites: DiagramSource[]
}

/** Owner for files outside every catalog module. */
export const REPO_OWNER = 'repository'

const sitesOf = (e: GraphEdge): DiagramSource[] =>
  e.sites.map((s) => ({ path: s.path, startLine: s.start.line + 1, endLine: s.end.line + 1 }))

/** The package an edge reaches, if it is an import of or call into an external package. */
function packageTarget(
  e: GraphEdge,
  nodes: Map<string, SoftwareGraph['nodes'][number]>
): string | null {
  if (e.resolution === 'external' && e.to) {
    const pkg = nodes.get(e.to)?.external?.package
    return pkg ?? null
  }
  if (e.resolution !== 'unresolved' || !e.target) return null
  const { text, reason } = e.target
  // Module-level import of a package that was never installed.
  if (e.kind === 'imports' && (e.role === 'module' || e.role === 'dynamic')) {
    return reason === 'dependency-not-installed' ? packageOf(text) : null
  }
  // A call through a binding imported from such a package.
  if (e.kind === 'calls' && reason?.startsWith('import-unresolved:')) {
    return packageOf(reason.slice('import-unresolved:'.length))
  }
  return null
}

/**
 * Who uses which external package. Files are attributed to the nearest catalog module by root,
 * the same rule catalog discovery uses.
 */
export function packageUses(graph: SoftwareGraph, catalog: CatalogGraph): PackageUse[] {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
  const modules = catalog.nodes
    .filter((n) => n.kind === 'module')
    .map((n) => ({
      id: n.id,
      root: (n.kind === 'module' && n.properties.root) || '.'
    }))
  const ownerOf = (path: string): string | undefined => {
    let best: { id: string; root: string } | undefined
    for (const m of modules) {
      if (m.root !== '.' && !path.startsWith(`${m.root}/`)) continue
      if (!best || best.root === '.' || (m.root !== '.' && m.root.length > best.root.length))
        best = m
    }
    // Repos without a package.json have no module nodes; their files belong to the repo itself.
    return best?.id ?? REPO_OWNER
  }
  const fileOf = (id: string): string | undefined =>
    id.startsWith('file:') ? id.slice('file:'.length) : nodes.get(id)?.path

  const uses = new Map<string, PackageUse>()
  for (const e of graph.edges) {
    const name = packageTarget(e, nodes)
    if (!name || IGNORED.test(name)) continue
    const file = fileOf(e.from)
    const owner = file && ownerOf(file)
    if (!file || !owner) continue
    const use: PackageUse = uses.get(name) ?? {
      name,
      category: categorize(name),
      users: new Map(),
      sites: []
    }
    const user = use.users.get(owner) ?? { files: new Set<string>(), calls: 0 }
    user.files.add(file)
    if (e.kind === 'calls') user.calls += 1
    else if (use.sites.length < 4) use.sites.push(...sitesOf(e).slice(0, 4 - use.sites.length))
    use.users.set(owner, user)
    uses.set(name, use)
  }
  const weight = (u: PackageUse): number =>
    [...u.users.values()].reduce((n, x) => n + x.calls + x.files.size, 0)
  return [...uses.values()].sort((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name))
}

const MAX_PACKAGES = 24

/**
 * The Integrations level: catalog operations plus the external packages the code uses, wired to
 * the modules that use them. General libraries are left out unless `includeLibraries` is set.
 */
export function integrationsDiagram(
  catalog: CatalogGraph,
  graph: SoftwareGraph | null,
  { includeLibraries = false } = {}
): Diagram & { hiddenLibraries: number } {
  const base = catalogDiagram(catalog, catalogKindsByLevel.integrations)
  if (!graph) return { ...base, hiddenLibraries: 0 }

  const all = packageUses(graph, catalog)
  const shown = all
    .filter((u) => includeLibraries || u.category !== 'library')
    .slice(0, MAX_PACKAGES)
  const hiddenLibraries = includeLibraries ? 0 : all.filter((u) => u.category === 'library').length

  const moduleNodes = new Map(
    catalog.nodes.filter((n) => n.kind === 'module').map((n) => [n.id, n])
  )
  const users = new Set(shown.flatMap((u) => [...u.users.keys()]))
  const existing = new Set(base.nodes.map((n) => n.id))

  const userNodes: DiagramNode[] = [...users]
    .filter((id) => !existing.has(id))
    .map((id): DiagramNode => {
      const m = moduleNodes.get(id)
      if (!m) {
        return {
          id,
          kind: 'Module',
          label: graph.repository.fullName,
          meta: 'Uses packages',
          detail: 'Files outside any package.json',
          change: 'unchanged',
          sources: []
        }
      }
      return {
        id,
        kind: 'Module',
        label: m.name,
        meta: 'Uses packages',
        detail: m.kind === 'module' ? m.properties.root : undefined,
        change: 'unchanged',
        sources: m.sources.map((s) => ({
          path: s.path,
          startLine: s.span ? s.span.start.line + 1 : undefined,
          endLine: s.span ? s.span.end.line + 1 : undefined
        }))
      }
    })

  const packageNodes: DiagramNode[] = shown.map((u) => {
    const files = new Set([...u.users.values()].flatMap((x) => [...x.files]))
    const calls = [...u.users.values()].reduce((n, x) => n + x.calls, 0)
    return {
      id: `package:${u.name}`,
      kind: CATEGORY_LABEL[u.category],
      label: u.name,
      meta: calls
        ? `${calls} call${calls === 1 ? '' : 's'}`
        : `${files.size} file${files.size === 1 ? '' : 's'}`,
      detail: `Imported in ${files.size} file${files.size === 1 ? '' : 's'}`,
      change: 'unchanged',
      sources: u.sites
    }
  })

  const packageEdges: DiagramEdge[] = shown.flatMap((u) =>
    [...u.users].map(([owner, x]) => ({
      id: `${owner}->package:${u.name}`,
      from: owner,
      to: `package:${u.name}`,
      label: x.calls ? `calls ×${x.calls}` : `imports ×${x.files.size}`,
      type: CATEGORY_PORT[u.category],
      change: 'unchanged' as const,
      sources: []
    }))
  )

  const nodes = [...base.nodes, ...userNodes, ...packageNodes]
  const edges = [...base.edges, ...packageEdges]
  const targets = new Set(edges.map((e) => e.to))
  const roots = nodes.filter((n) => !targets.has(n.id)).map((n) => n.id)
  return {
    roots: roots.length ? roots : nodes.slice(0, 1).map((n) => n.id),
    nodes,
    edges,
    hiddenLibraries
  }
}
