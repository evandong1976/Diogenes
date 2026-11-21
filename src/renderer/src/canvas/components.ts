import { createContext, useContext } from 'react'
import type { CatalogKind, CatalogProtocol } from '../../../shared/catalog'
import tokens from '../../../../design/tokens.json'
import type { DiagramEdge, DiagramNode, PortType } from './diagrams'
import type { Point } from './layout'

/** The three levels, as named in the sidebar and canvas toolbar. */
export const LEVELS = [
  { name: 'Infra', tag: 'INFRA' },
  { name: 'Integrations', tag: 'INTEGRATIONS' },
  { name: 'Logic', tag: 'LOGIC' }
] as const

/** Design system v0.3 kind icons: SVG children for a 24px viewBox, stroke 1.8. */
const ICONS = Object.fromEntries(
  Object.entries(tokens.catalog.kinds).map(([kind, v]) => [kind, (v as { icon: string }).icon])
) as Record<CatalogKind, string>

export const iconFor = (kind: CatalogKind): string => ICONS[kind] ?? ICONS.generic

/** Best guess at a catalog kind for nodes that didn't come from the catalog (Gemini, state graphs). */
export function guessKind(node: DiagramNode): CatalogKind {
  if (node.catalogKind) return node.catalogKind
  const k = node.kind.toLowerCase()
  if (k.includes('state')) return 'stateMachine'
  if (/service|server|workload|worker|app/.test(k)) return 'workload'
  if (/data|store|db|cache|queue|bucket|resource/.test(k)) return 'resource'
  if (/package|library|module/.test(k)) return 'module'
  if (/view|page|ui|client/.test(k)) return 'view'
  if (/cron|trigger|schedule|event/.test(k)) return 'trigger'
  if (/api|route|endpoint|operation/.test(k)) return 'operation'
  return 'generic'
}

/** OffBit protocol codes from design system v0.3. */
export const PROTOCOL_CODE: Record<CatalogProtocol, string> = {
  http: 'HTTP',
  rpc: 'RPC',
  'electron-ipc': 'IPC',
  cli: 'CLI',
  data: 'DATA',
  state: 'STATE',
  event: 'EVT',
  schedule: 'SCHED',
  navigation: 'NAV',
  local: 'LOCAL'
}

const PORT_PROTOCOL: Record<PortType, CatalogProtocol> = {
  http: 'http',
  data: 'data',
  auth: 'http',
  event: 'event'
}
export const PROTOCOL_PORT_TYPE = (p: CatalogProtocol): PortType =>
  p === 'data' || p === 'state' || p === 'local'
    ? 'data'
    : p === 'event' || p === 'schedule'
      ? 'event'
      : 'http'

/** Protocol for a node's output: its own, else its first outgoing edge's, else local. */
export function outProtocol(node: DiagramNode, edges: DiagramEdge[]): CatalogProtocol {
  if (node.protocol) return node.protocol
  const out = edges.find((e) => e.from === node.id)
  return out ? PORT_PROTOCOL[out.type] : 'local'
}

/** Components the user can drag onto the canvas. They start as proposed (not in the repo). */
export const PALETTE: {
  id: string
  name: string
  kind: CatalogKind
  type: string
  protocol: CatalogProtocol
  detail: string
}[] = [
  {
    id: 'service',
    name: 'Service',
    kind: 'workload',
    type: 'SERVICE',
    protocol: 'http',
    detail: 'Runs code'
  },
  {
    id: 'endpoint',
    name: 'Endpoint',
    kind: 'operation',
    type: 'OP',
    protocol: 'http',
    detail: 'GET /path'
  },
  {
    id: 'view',
    name: 'View',
    kind: 'view',
    type: 'VIEW',
    protocol: 'navigation',
    detail: '/route'
  },
  {
    id: 'database',
    name: 'Database',
    kind: 'resource',
    type: 'STORE',
    protocol: 'data',
    detail: 'Tables'
  },
  {
    id: 'cache',
    name: 'Cache',
    kind: 'resource',
    type: 'STORE',
    protocol: 'data',
    detail: 'Key / value'
  },
  {
    id: 'queue',
    name: 'Queue',
    kind: 'resource',
    type: 'QUEUE',
    protocol: 'event',
    detail: 'Messages'
  },
  {
    id: 'cron',
    name: 'Cron',
    kind: 'trigger',
    type: 'TRIGGER',
    protocol: 'schedule',
    detail: '0 3 * * *'
  },
  {
    id: 'states',
    name: 'States',
    kind: 'stateMachine',
    type: 'STATES',
    protocol: 'state',
    detail: 'States'
  },
  { id: 'box', name: 'Box', kind: 'generic', type: 'NODE', protocol: 'local', detail: 'Anything' }
]

export const DRAG_COMPONENT = 'application/x-diogenes-component'
export const DRAG_FILE = 'application/x-diogenes-file'

export function newComponent(templateId: string): DiagramNode | null {
  const t = PALETTE.find((p) => p.id === templateId)
  if (!t) return null
  return {
    id: `draft-${crypto.randomUUID().slice(0, 8)}`,
    kind: t.name,
    label: `New ${t.name.toLowerCase()}`,
    meta: 'Not in repo',
    detail: t.detail,
    change: 'added',
    catalogKind: t.kind,
    type: t.type,
    protocol: t.protocol,
    sources: []
  }
}

/** What the user added on top of a level's diagram. Kept per level, for the session. */
export type Draft = {
  nodes: DiagramNode[]
  edges: DiagramEdge[]
  /** Positions the user dragged nodes to (indexed and drafted alike). */
  positions: Record<string, Point>
  /** Files the user dropped onto a component, by node ID. */
  links: Record<string, string[]>
}

export const emptyDraft: Draft = { nodes: [], edges: [], positions: {}, links: {} }

export interface Workspace {
  /** Shown in the canvas toolbar, e.g. "L1 · INFRA". */
  levelTag: string
  draft: Draft
  setDraft(update: (d: Draft) => Draft): void
  /** A file picked in the sidebar: its components are highlighted. */
  focusFile: string | null
}

export const WorkspaceContext = createContext<Workspace>({
  levelTag: '',
  draft: emptyDraft,
  setDraft: () => {},
  focusFile: null
})

export const useWorkspace = (): Workspace => useContext(WorkspaceContext)

/** Keeps the filename and range: `src/renderer/…/RepoPicker.tsx:12–40`. */
export function middleTruncate(path: string, max = 34): string {
  if (path.length <= max) return path
  const parts = path.split('/')
  const tail = parts.slice(-1)[0]
  const head = parts[0]
  const short = `${head}/…/${tail}`
  return short.length <= max ? short : `…/${tail}`
}

export const formatSource = (s: { path: string; startLine?: number; endLine?: number }): string =>
  s.startLine === undefined
    ? s.path
    : `${s.path}:${s.startLine}${s.endLine !== undefined && s.endLine !== s.startLine ? `–${s.endLine}` : ''}`
