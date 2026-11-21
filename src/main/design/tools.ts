import type {
  CatalogEdge,
  CatalogGraph,
  CatalogNode,
  CatalogOperation,
  CatalogPatch
} from '../../shared/catalog'
import type {
  ApprovedIntent,
  EvidenceRecord,
  ProposalPreview,
  VerificationReport
} from '../../shared/design'
import { applyCatalogPatch } from '../catalog/editing'
import type { FunctionDeclaration } from './model'

/** Reads a repo file at an exact commit. Null when the file is not in that commit. */
export type SourceReader = (
  repository: { id: number; fullName: string },
  commitSha: string,
  path: string
) => Promise<string | null>

/** Verification results for approved intents, owned by the coding/verification service. */
export interface VerificationSource {
  latest(intentId: string): Promise<VerificationReport | null>
}

/** What a tool sees: the draft pinned at turn start, plus ledgers the harness keeps. */
export interface ToolContext {
  graph: CatalogGraph
  readSource: SourceReader
  verification: VerificationSource
  /** Approved intents from this thread, newest last. */
  intents: ApprovedIntent[]
  evidence: EvidenceRecord[]
  turnId: string
  signal: AbortSignal
}

export type ToolOutcome =
  | { ok: true; response: Record<string, unknown>; summary: string }
  | { ok: false; response: { error: string }; summary: string }
  | {
      ok: true
      response: Record<string, unknown>
      summary: string
      proposal: { summary: string; patch: CatalogPatch; preview: ProposalPreview; evidence: EvidenceRecord[] }
    }
  | {
      ok: true
      response: Record<string, unknown>
      summary: string
      correction: { intentId: string; runId: string; failedChecks: string[]; instructions: string }
    }

const MAX_OPERATIONS = 20
const MAX_EXCERPT_LINES = 80
const KINDS = [
  'module',
  'workload',
  'operation',
  'resource',
  'dataContract',
  'stateMachine',
  'view',
  'trigger',
  'workflow',
  'generic'
]
const EDGE_KINDS = [
  'contains',
  'depends_on',
  'calls',
  'publishes_to',
  'subscribes_to',
  'reads',
  'writes',
  'triggers',
  'flows_to',
  'navigates_to'
]
const PROTOCOLS = [
  'local',
  'electron-ipc',
  'http',
  'rpc',
  'cli',
  'event',
  'data',
  'schedule',
  'navigation',
  'state'
]

const str = (description: string): Record<string, unknown> => ({ type: 'string', description })
const endpoint = {
  type: 'object',
  properties: { nodeId: { type: 'string' }, portId: { type: 'string' } },
  required: ['nodeId']
}
const edgeSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: EDGE_KINDS },
    from: endpoint,
    to: endpoint
  },
  required: ['id', 'kind', 'from', 'to']
}
const nodeSchema = {
  type: 'object',
  properties: {
    id: str('Stable kebab-case ID, unique in the graph.'),
    kind: { type: 'string', enum: KINDS },
    name: { type: 'string' },
    properties: { type: 'object', description: 'Kind-specific properties, e.g. {"protocol":"local"}.' },
    ports: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          direction: { type: 'string', enum: ['in', 'out'] },
          protocol: { type: 'string', enum: PROTOCOLS },
          contractId: str('ID of a dataContract node in the graph.'),
          maxConnections: { type: 'integer' }
        },
        required: ['id', 'direction', 'protocol']
      }
    }
  },
  required: ['id', 'kind', 'name']
}

export const toolDeclarations: FunctionDeclaration[] = [
  {
    name: 'inspect_component',
    description:
      'Read one component of the working draft: kind, properties, ports, cited source locations, and its direct connections.',
    parametersJsonSchema: {
      type: 'object',
      properties: { componentId: str('Catalog node ID.') },
      required: ['componentId']
    }
  },
  {
    name: 'follow_connections',
    description:
      'List the connections reachable from a component, up to 3 hops, with the components at each end.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        componentId: { type: 'string' },
        direction: { type: 'string', enum: ['in', 'out', 'both'] },
        depth: { type: 'integer', minimum: 1, maximum: 3 }
      },
      required: ['componentId']
    }
  },
  {
    name: 'read_source',
    description:
      'Read the source text a component or connection cites, at the draft commit. Returns an evidenceId to cite in a proposal.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        entityId: str('Component or connection ID.'),
        sourceIndex: { type: 'integer', minimum: 0, description: 'Which cited source. Default 0.' }
      },
      required: ['entityId']
    }
  },
  {
    name: 'propose_graph_edit',
    description:
      'Propose an ordered, atomic catalog patch against the working draft. Diogenes validates it and shows the developer a preview; nothing changes until they approve. On a validation issue, fix the operations and call again.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        summary: str('One or two sentences the developer will approve.'),
        evidenceIds: { type: 'array', items: { type: 'string' } },
        operations: {
          type: 'array',
          maxItems: MAX_OPERATIONS,
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['create', 'update', 'connect', 'disconnect', 'rewire', 'insert', 'delete']
              },
              node: nodeSchema,
              edge: edgeSchema,
              edgeId: str('For disconnect and insert.'),
              nodeId: str('For delete.'),
              incoming: edgeSchema,
              outgoing: edgeSchema
            },
            required: ['type']
          }
        }
      },
      required: ['summary', 'operations']
    }
  },
  {
    name: 'read_verification',
    description:
      'Read the latest local verification of the coding run for an approved intent in this thread: which checks passed or failed and the candidate diff.',
    parametersJsonSchema: {
      type: 'object',
      properties: { intentId: str('Defaults to the newest approved intent in this thread.') }
    }
  },
  {
    name: 'request_correction',
    description:
      'Ask the coding run to correct its candidate for an approved intent after a failed verification. The approved intent itself does not change.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        intentId: { type: 'string' },
        instructions: str('What the candidate must change, tied to the failed checks.')
      },
      required: ['intentId', 'instructions']
    }
  }
]

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'inspect_component':
        return inspect(ctx.graph, text(args.componentId, 'componentId'))
      case 'follow_connections':
        return follow(ctx.graph, args)
      case 'read_source':
        return await readSource(ctx, args)
      case 'propose_graph_edit':
        return propose(ctx, args)
      case 'read_verification':
        return await readVerification(ctx, args)
      case 'request_correction':
        return await requestCorrection(ctx, args)
      default:
        return failure(`Unknown tool ${name}.`)
    }
  } catch (error) {
    if (error instanceof ArgumentError) return failure(error.message)
    throw error
  }
}

class ArgumentError extends Error {}

function failure(error: string): ToolOutcome {
  return { ok: false, response: { error }, summary: error }
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ArgumentError(`${field} is required.`)
  return value
}

function node(graph: CatalogGraph, id: string): CatalogNode {
  const found = graph.nodes.find((n) => n.id === id)
  if (!found) throw new ArgumentError(`Component ${id} is not in draft revision ${graph.revision}.`)
  return found
}

const edgeView = (graph: CatalogGraph, e: CatalogEdge): Record<string, unknown> => ({
  id: e.id,
  kind: e.kind,
  from: { ...e.from, name: graph.nodes.find((n) => n.id === e.from.nodeId)?.name },
  to: { ...e.to, name: graph.nodes.find((n) => n.id === e.to.nodeId)?.name },
  sourceCount: e.sources.length
})

function inspect(graph: CatalogGraph, id: string): ToolOutcome {
  const component = node(graph, id)
  const incoming = graph.edges.filter((e) => e.to.nodeId === id)
  const outgoing = graph.edges.filter((e) => e.from.nodeId === id)
  return {
    ok: true,
    summary: `Inspected ${component.name} (${incoming.length} in, ${outgoing.length} out)`,
    response: {
      revision: graph.revision,
      component: {
        ...component,
        sources: component.sources.map((s, index) => ({
          index,
          path: s.path,
          // Shown 1-based, like an editor.
          lines: s.span ? `${s.span.start.line + 1}-${s.span.end.line + 1}` : undefined,
          field: s.field
        }))
      },
      incoming: incoming.map((e) => edgeView(graph, e)),
      outgoing: outgoing.map((e) => edgeView(graph, e))
    }
  }
}

function follow(graph: CatalogGraph, args: Record<string, unknown>): ToolOutcome {
  const start = node(graph, text(args.componentId, 'componentId')).id
  const direction = args.direction ?? 'both'
  if (direction !== 'in' && direction !== 'out' && direction !== 'both')
    throw new ArgumentError('direction must be in, out or both.')
  const depth = args.depth ?? 1
  if (!Number.isInteger(depth) || (depth as number) < 1 || (depth as number) > 3)
    throw new ArgumentError('depth must be 1, 2 or 3.')
  const seen = new Set([start])
  const edges = new Map<string, CatalogEdge>()
  let frontier = [start]
  for (let hop = 0; hop < (depth as number); hop++) {
    const next: string[] = []
    for (const e of graph.edges) {
      const outward = direction !== 'in' && frontier.includes(e.from.nodeId)
      const inward = direction !== 'out' && frontier.includes(e.to.nodeId)
      if (!outward && !inward) continue
      edges.set(e.id, e)
      for (const id of [outward ? e.to.nodeId : null, inward ? e.from.nodeId : null]) {
        if (id && !seen.has(id)) {
          seen.add(id)
          next.push(id)
        }
      }
    }
    frontier = next
  }
  return {
    ok: true,
    summary: `Followed ${edges.size} connection(s) from ${start}`,
    response: {
      revision: graph.revision,
      connections: [...edges.values()].map((e) => edgeView(graph, e)),
      components: [...seen].map((id) => {
        const n = graph.nodes.find((x) => x.id === id)!
        return { id, name: n.name, kind: n.kind }
      })
    }
  }
}

async function readSource(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const entityId = text(args.entityId, 'entityId')
  const entity =
    ctx.graph.nodes.find((n) => n.id === entityId) ?? ctx.graph.edges.find((e) => e.id === entityId)
  if (!entity) throw new ArgumentError(`${entityId} is not in draft revision ${ctx.graph.revision}.`)
  const index = args.sourceIndex ?? 0
  const source = Number.isInteger(index) ? entity.sources[index as number] : undefined
  if (!source)
    throw new ArgumentError(`${entityId} cites ${entity.sources.length} source(s); no index ${index}.`)

  const reused = ctx.evidence.find(
    (e) => e.entityId === entityId && e.path === source.path && e.startLine === startOf(source)
  )
  if (reused) return evidenceOutcome(reused)

  const file = await ctx.readSource(ctx.graph.repository, ctx.graph.commit.sha, source.path)
  if (file === null)
    return failure(`${source.path} is not readable at ${ctx.graph.commit.sha.slice(0, 7)}.`)
  const lines = file.split(/\r?\n/)
  const startLine = startOf(source)
  const endLine = Math.min(
    lines.length,
    source.span ? source.span.end.line + 3 : MAX_EXCERPT_LINES,
    startLine + MAX_EXCERPT_LINES
  )
  const record: EvidenceRecord = {
    id: `${ctx.turnId}-ev${ctx.evidence.length + 1}`,
    entityId,
    commitSha: ctx.graph.commit.sha,
    path: source.path,
    startLine,
    endLine,
    excerpt: lines
      .slice(startLine, endLine)
      .map((line, i) => `${startLine + i + 1}: ${line}`)
      .join('\n')
  }
  ctx.evidence.push(record)
  return evidenceOutcome(record)
}

const startOf = (source: { span?: { start: { line: number } } }): number =>
  Math.max(0, (source.span?.start.line ?? 0) - 2)

function evidenceOutcome(record: EvidenceRecord): ToolOutcome {
  return {
    ok: true,
    summary: `Read ${record.path}:${record.startLine + 1}-${record.endLine}`,
    response: {
      evidenceId: record.id,
      path: record.path,
      commit: record.commitSha,
      text: record.excerpt
    }
  }
}

function propose(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  const summary = text(args.summary, 'summary')
  if (!Array.isArray(args.operations) || !args.operations.length)
    throw new ArgumentError('operations must be a non-empty array.')
  if (args.operations.length > MAX_OPERATIONS)
    throw new ArgumentError(`At most ${MAX_OPERATIONS} operations per proposal.`)
  const evidenceIds = args.evidenceIds ?? []
  if (!Array.isArray(evidenceIds) || evidenceIds.some((id) => typeof id !== 'string'))
    throw new ArgumentError('evidenceIds must be a list of IDs returned by read_source.')
  const evidence = evidenceIds.map((id) => {
    const found = ctx.evidence.find((e) => e.id === id)
    if (!found) throw new ArgumentError(`Unknown evidenceId ${id}; call read_source first.`)
    return found
  })

  // The harness, not the model, pins the patch to the draft the turn started from.
  const patch: CatalogPatch = {
    repositoryId: ctx.graph.repository.id,
    commitSha: ctx.graph.commit.sha,
    baseRevision: ctx.graph.revision,
    operations: args.operations.map((op, i) => operation(op, i))
  }
  const result = applyCatalogPatch(ctx.graph, patch)
  if (!result.ok) {
    const { code, message, operationIndex } = result.issue
    return {
      ok: false,
      summary: `Rejected by the graph editor: ${message}`,
      response: {
        error: `The graph editor rejected the patch (${code}${operationIndex === undefined ? '' : ` at operation ${operationIndex}`}): ${message}`
      }
    }
  }
  const preview = previewOf(ctx.graph, result.graph)
  return {
    ok: true,
    summary: `Proposed: ${summary}`,
    proposal: { summary, patch, preview, evidence },
    response: {
      status: 'awaiting developer approval',
      preview,
      note: 'Recorded. Explain the change and its evidence to the developer; do not call more tools.'
    }
  }
}

/** Shapes model arguments into a CatalogOperation. Semantics are left to the graph editor. */
function operation(value: unknown, index: number): CatalogOperation {
  const op = value as Record<string, unknown> | null
  const at = `operations[${index}]`
  if (!op || typeof op !== 'object') throw new ArgumentError(`${at} must be an object.`)
  const edge = (v: unknown, field: string): CatalogEdge => {
    const e = v as Partial<CatalogEdge> | null
    if (!e || typeof e !== 'object' || !e.from || !e.to)
      throw new ArgumentError(`${at}.${field} needs id, kind, from and to.`)
    return { id: e.id!, kind: e.kind!, from: e.from, to: e.to, sources: e.sources ?? [] }
  }
  const catalogNode = (v: unknown): CatalogNode => {
    const n = v as Partial<CatalogNode> | null
    if (!n || typeof n !== 'object') throw new ArgumentError(`${at}.node must be an object.`)
    return {
      id: n.id!,
      kind: n.kind!,
      name: n.name!,
      resolution: n.resolution ?? 'proposed',
      properties: n.properties ?? {},
      ports: Array.isArray(n.ports) ? n.ports : [],
      sources: Array.isArray(n.sources) ? n.sources : []
    } as CatalogNode
  }
  switch (op.type) {
    case 'create':
    case 'update':
      return { type: op.type, node: catalogNode(op.node) }
    case 'connect':
    case 'rewire':
      return { type: op.type, edge: edge(op.edge, 'edge') }
    case 'disconnect':
      return { type: 'disconnect', edgeId: text(op.edgeId, `${at}.edgeId`) }
    case 'delete':
      return { type: 'delete', nodeId: text(op.nodeId, `${at}.nodeId`) }
    case 'insert':
      return {
        type: 'insert',
        edgeId: text(op.edgeId, `${at}.edgeId`),
        node: catalogNode(op.node),
        incoming: edge(op.incoming, 'incoming'),
        outgoing: edge(op.outgoing, 'outgoing')
      }
    default:
      throw new ArgumentError(`${at}.type ${String(op.type)} is not a catalog operation.`)
  }
}

export function previewOf(before: CatalogGraph, after: CatalogGraph): ProposalPreview {
  const name = (id: string): string =>
    (after.nodes.find((n) => n.id === id) ?? before.nodes.find((n) => n.id === id))?.name ?? id
  const oldNodes = new Map(before.nodes.map((n) => [n.id, n]))
  const newNodes = new Map(after.nodes.map((n) => [n.id, n]))
  const components: ProposalPreview['components'] = []
  for (const [id, n] of newNodes) {
    const old = oldNodes.get(id)
    if (!old) components.push({ id, name: n.name, change: 'added' })
    else if (JSON.stringify(old) !== JSON.stringify(n))
      components.push({ id, name: n.name, change: 'updated' })
  }
  for (const [id, n] of oldNodes)
    if (!newNodes.has(id)) components.push({ id, name: n.name, change: 'removed' })

  const key = (e: CatalogEdge): string => JSON.stringify([e.kind, e.from, e.to])
  const oldEdges = new Map(before.edges.map((e) => [e.id, e]))
  const newEdges = new Map(after.edges.map((e) => [e.id, e]))
  const connections: ProposalPreview['connections'] = []
  const view = (e: CatalogEdge, change: 'added' | 'removed'): ProposalPreview['connections'][0] => ({
    id: e.id,
    kind: e.kind,
    from: name(e.from.nodeId),
    to: name(e.to.nodeId),
    change
  })
  for (const [id, e] of oldEdges) {
    const next = newEdges.get(id)
    if (!next || key(next) !== key(e)) connections.push(view(e, 'removed'))
  }
  for (const [id, e] of newEdges) {
    const old = oldEdges.get(id)
    if (!old || key(old) !== key(e)) connections.push(view(e, 'added'))
  }
  return { baseRevision: before.revision, resultRevision: after.revision, components, connections }
}

function pickIntent(ctx: ToolContext, value: unknown): ApprovedIntent {
  if (value === undefined) {
    const latest = ctx.intents.at(-1)
    if (!latest) throw new ArgumentError('No change in this thread has been approved yet.')
    return latest
  }
  const found = ctx.intents.find((i) => i.id === value)
  if (!found) throw new ArgumentError(`Intent ${String(value)} is not an approved intent in this thread.`)
  return found
}

async function readVerification(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const intent = pickIntent(ctx, args.intentId)
  const report = await ctx.verification.latest(intent.id)
  if (!report)
    return {
      ok: true,
      summary: `No verification yet for ${intent.id}`,
      response: { intentId: intent.id, status: 'not-run' }
    }
  const failed = report.checks.filter((c) => !c.passed).map((c) => c.name)
  return {
    ok: true,
    summary: `Verification ${report.status} for ${intent.id}${failed.length ? `: ${failed.join(', ')}` : ''}`,
    response: { intent: { id: intent.id, summary: intent.summary }, report }
  }
}

async function requestCorrection(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ToolOutcome> {
  const intent = pickIntent(ctx, text(args.intentId, 'intentId'))
  const instructions = text(args.instructions, 'instructions')
  const report = await ctx.verification.latest(intent.id)
  const failedChecks = report?.checks.filter((c) => !c.passed).map((c) => c.name) ?? []
  if (!report || report.status === 'passed' || !failedChecks.length)
    return failure(`Intent ${intent.id} has no failed verification to correct.`)
  return {
    ok: true,
    summary: `Requested a correction for ${intent.id}`,
    correction: { intentId: intent.id, runId: report.runId, failedChecks, instructions },
    response: { status: 'correction requested', intentId: intent.id, failedChecks }
  }
}
