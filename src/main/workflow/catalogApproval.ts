/**
 * Freezes any valid catalog patch that is not the refund proof path into a `CatalogApprovedChange`.
 *
 * The packet states what the candidate must make true in terms the local verifier can observe
 * by re-indexing it: which connections must appear, which must disappear, and which unchanged
 * connections of the touched components must survive. Node changes the indexer cannot see are
 * listed as `unobservable` and stay `unknown`. The editable scope and the source handed to the
 * coding agent are the directories holding the touched components' source at the base commit.
 */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { loadTypescript } from '../indexing/scip.ts'
import { ApprovalError, git, type FrozenApproval } from './approval.ts'
import type { CatalogEdge, CatalogGraph, CatalogNode, CatalogOperation } from '../../shared/catalog'
import type { Proposal } from '../../shared/design'
import type {
  ApprovalRequest,
  CatalogApprovedChange,
  ConnectionExpectation,
  HandoffPlan,
  SourceContext
} from '../../shared/workflow'

export const CATALOG_VERIFIER_ID = 'diogenes-catalog-v1'

/** Unchanged connections of touched components that are re-checked. */
const MAX_PRESERVED = 20
const MAX_FILE_BYTES = 200_000
/** Below the provider's 2 MB inline limit, which also holds a pristine copy and the export script. */
const MAX_CONTEXT_BYTES = 900_000

type Triple = Pick<CatalogEdge, 'kind'> & { from: string; to: string }

const tripleOf = (e: CatalogEdge): Triple => ({
  kind: e.kind,
  from: e.from.nodeId,
  to: e.to.nodeId
})
const key = (t: Triple): string => `${t.kind}:${t.from}->${t.to}`

export function freezeCatalog(
  repoDir: string,
  request: ApprovalRequest,
  after: CatalogGraph
): FrozenApproval {
  const { baseline, patch, correlation } = request
  const base = baseline.commit.sha
  const observed = new Set(baseline.nodes.map((n) => n.id))
  const createdContracts = new Set(
    patch.operations.flatMap((op) =>
      op.type === 'create' && op.node.kind === 'dataContract' && !op.node.ports.length
        ? [op.node.id]
        : []
    )
  )
  const groupsContract = (edge: CatalogEdge): boolean =>
    edge.kind === 'contains' && createdContracts.has(edge.to.nodeId)
  const names = new Map<string, string>()
  for (const n of [...baseline.nodes, ...after.nodes]) names.set(n.id, n.name)
  const name = (id: string): string => names.get(id) ?? id

  const beforeEdges = new Map(baseline.edges.map((e) => [e.id, e]))
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]))
  const afterKeys = new Set(after.edges.map((e) => key(tripleOf(e))))
  const beforeKeys = new Set(baseline.edges.map((e) => key(tripleOf(e))))

  const added = after.edges.filter((e) => {
    const old = beforeEdges.get(e.id)
    return !old || key(tripleOf(old)) !== key(tripleOf(e))
  })
  const codeAdded = added.filter((e) => !groupsContract(e))
  const removed = baseline.edges.filter((e) => {
    const now = afterEdges.get(e.id)
    return (!now || key(tripleOf(now)) !== key(tripleOf(e))) && !afterKeys.has(key(tripleOf(e)))
  })

  const touched = new Set<string>()
  for (const op of patch.operations) {
    if ((op.type === 'connect' || op.type === 'rewire') && groupsContract(op.edge)) continue
    for (const id of nodeIdsOf(op)) touched.add(id)
  }
  for (const e of [...codeAdded, ...removed]) touched.add(e.from.nodeId).add(e.to.nodeId)

  const describeEdge = (t: Triple): string => `${name(t.from)} ${t.kind} ${name(t.to)}`
  const connections: ConnectionExpectation[] = []
  const unobservable: string[] = []
  for (const e of codeAdded) {
    const t = tripleOf(e)
    // A proposed node has a designer-chosen ID the indexer will not reproduce.
    if (!observed.has(t.from) || !observed.has(t.to) || beforeKeys.has(key(t))) {
      if (!beforeKeys.has(key(t))) unobservable.push(`connect ${describeEdge(t)} (new component)`)
      continue
    }
    connections.push({
      id: `present:${key(t)}`,
      expect: 'present',
      origin: 'required',
      ...t,
      description: `${describeEdge(t)} is connected`
    })
  }
  for (const e of removed) {
    const t = tripleOf(e)
    connections.push({
      id: `absent:${key(t)}`,
      expect: 'absent',
      origin: 'required',
      ...t,
      description: `${describeEdge(t)} is no longer connected`
    })
  }
  const changed = new Set([...added, ...removed].map((e) => e.id))
  const preserved = baseline.edges
    .filter((e) => !changed.has(e.id) && afterEdges.has(e.id))
    .filter((e) => touched.has(e.from.nodeId) || touched.has(e.to.nodeId))
    .slice(0, MAX_PRESERVED)
  for (const e of preserved) {
    const t = tripleOf(e)
    connections.push({
      id: `preserved:${key(t)}`,
      expect: 'present',
      origin: 'preserved',
      ...t,
      description: `${describeEdge(t)} stays connected`
    })
  }
  const annotations = added
    .filter(groupsContract)
    .map((edge) => `group data contract ${name(edge.to.nodeId)} under ${name(edge.from.nodeId)}`)
  const baseNodes = new Map(baseline.nodes.map((n) => [n.id, n]))
  for (const op of patch.operations) {
    // Declaring a port contract is design metadata the editor requires before connecting;
    // it asks nothing of the code.
    if (op.type === 'update' && contractsOnly(baseNodes.get(op.node.id), op.node)) {
      annotations.push(`declare port contracts on ${name(op.node.id)}`)
      continue
    }
    if (op.type === 'create' && op.node.kind === 'dataContract' && !op.node.ports.length) {
      annotations.push(`declare data contract ${op.node.name}`)
      continue
    }
    const text = nodeChange(op, name)
    if (text) unobservable.push(text)
  }
  if (!connections.some((c) => c.origin === 'required') && !unobservable.length)
    throw new ApprovalError('The proposal changes nothing a candidate could implement.')

  const behaviorChanged = patch.operations.some(
    (op) =>
      (op.type === 'update' || op.type === 'create') &&
      op.node.kind === 'stateMachine' &&
      !!op.node.properties.behavior
  )

  const planFiles = request.plan ? planFilesAt(repoDir, base, request.plan.files ?? []) : []
  let scope = withFiles(
    editableScope(baseline, after, touched, [...codeAdded, ...removed]),
    planFiles
  )
  if (!scope.length && request.plan?.evidence.length) {
    const evidenceFiles = planFilesAt(repoDir, base, [
      ...new Set(request.plan.evidence.map((e) => e.path))
    ])
    scope = [
      ...new Set(
        evidenceFiles.map((path) => {
          const directory = posix.dirname(path)
          return directory === '.' ? path : directory
        })
      )
    ].sort()
  }
  if (!scope.length)
    throw new ApprovalError('The touched components have no source files to change.')
  const sourceContext = contextFor(repoDir, base, scope)

  const required = connections.filter((c) => c.origin === 'required')
  const packet: CatalogApprovedChange = {
    version: 1,
    kind: 'catalog',
    repository: baseline.repository,
    baseCommit: base,
    catalog: { schemaVersion: baseline.schemaVersion, revision: baseline.revision },
    // Name a component, not a contract annotation the editor needed for the ports.
    targetComponentId:
      [...touched].find(
        (id) => baseNodes.get(id)?.kind !== 'dataContract' && !createdContracts.has(id)
      ) ??
      [...touched][0] ??
      patch.operations[0].type,
    beforeDigest: graphDigest(baseline),
    patch,
    afterDigest: graphDigest(after),
    scope,
    connections,
    unobservable,
    annotations,
    obligations: [
      {
        id: 'native-typecheck',
        scope:
          'The TypeScript compiler reports no diagnostic for the candidate that the base commit does not already have. Dependencies are not installed; compilation only, not behavior.'
      },
      {
        id: 'catalog-conformance',
        scope: `Re-indexing the candidate shows ${required.length} required connection change(s) and keeps ${preserved.length} unchanged connection(s) of the touched components.${unobservable.length ? ` ${unobservable.length} node change(s) are not observable and stay unknown.` : ''}`
      },
      ...(behaviorChanged
        ? [
            {
              id: 'bend-law' as const,
              scope:
                'The changed state machine behavior has no Bend proof binding here, so it is not proven.'
            }
          ]
        : [])
    ],
    requiredChanges: [...required.map((c) => c.description), ...unobservable],
    preserved: [
      ...preserved.map((e) => `${describeEdge(tripleOf(e))} stays connected`),
      'other behavior of the touched files is unchanged'
    ],
    openChoices: ['how the change is implemented within the editable scope', 'helper names'],
    toolchain: { verifier: CATALOG_VERIFIER_ID, typescript: loadTypescript().version },
    correlation,
    sourceContext,
    ...(request.plan && { plan: { ...handoffPlan(request.plan, scope), files: planFiles } })
  }
  const bytes = `${JSON.stringify(packet, null, 2)}\n`
  return { approvalId: sha256(bytes), packet, bytes }
}

/**
 * The plan's extra files, checked at the base commit: an existing path must be a regular file,
 * and a missing one must look like a new file (a name with an extension). Directories and the
 * repository root are refused, so a plan can widen the scope only by naming files.
 */
function planFilesAt(repoDir: string, base: string, files: string[]): string[] {
  for (const path of files) {
    if (!isRepoPath(path) || path === '.')
      throw new ApprovalError(`The plan names ${path}, which is not a repository-relative file.`)
    const listing = git(repoDir, ['ls-tree', '-z', base, '--', path])
    const [meta, listed] = listing.split('\0')[0].split('\t')
    if (listed === path) {
      const [mode, type] = meta.split(/\s+/)
      if (type !== 'blob' || mode === '120000')
        throw new ApprovalError(
          `The plan names ${path}, which is not a regular file at ${base.slice(0, 7)}.`
        )
    } else if (!/[^/]\.[A-Za-z0-9]+$/.test(path)) {
      throw new ApprovalError(
        `The plan names ${path}, which does not exist and does not look like a new file.`
      )
    }
  }
  return [...files].sort()
}

/** Scope entries plus plan files not already covered by one. */
function withFiles(scope: string[], files: string[]): string[] {
  const covered = (p: string): boolean => scope.some((e) => p === e || p.startsWith(`${e}/`))
  return [...scope, ...files.filter((f) => !covered(f))].sort()
}

/**
 * The approval-time plan for a proposal: its plan and summary, with only the evidence read at
 * the base commit the packet freezes. Undefined for proposals recorded without a plan.
 */
export function planForApproval(proposal: Proposal, baseCommit: string): HandoffPlan | undefined {
  if (!proposal.plan) return undefined
  return {
    summary: proposal.summary,
    ...proposal.plan,
    evidence: proposal.evidence
      .filter((e) => e.commitSha === baseCommit)
      .map(({ path, startLine, endLine, excerpt }) => ({ path, startLine, endLine, excerpt }))
  }
}

const MAX_EVIDENCE = 8
const MAX_EXCERPT_CHARS = 4_000

/**
 * The plan as frozen: evidence keeps only repository paths, each excerpt is bounded, and the
 * acceptance checks stay guidance. The backend passes only evidence read at the base commit.
 */
export function handoffPlan(plan: HandoffPlan, scope: string[]): HandoffPlan {
  const inScope = (path: string): boolean =>
    scope.some((entry) => path === entry || path.startsWith(`${entry}/`))
  const evidence = plan.evidence
    .filter((e) => isRepoPath(e.path))
    // In-scope source first: that is what the coding agent will edit.
    .sort((a, b) => Number(inScope(b.path)) - Number(inScope(a.path)))
    .slice(0, MAX_EVIDENCE)
    .map((e) => ({ ...e, excerpt: e.excerpt.slice(0, MAX_EXCERPT_CHARS) }))
  return {
    summary: plan.summary,
    ...(plan.conversationSummary && { conversationSummary: plan.conversationSummary }),
    behavior: plan.behavior,
    steps: [...plan.steps],
    preserved: [...plan.preserved],
    ...(plan.implementationChoices?.length && {
      implementationChoices: [...plan.implementationChoices]
    }),
    acceptance: [...plan.acceptance],
    evidence
  }
}

function nodeIdsOf(op: CatalogOperation): string[] {
  switch (op.type) {
    case 'create':
    case 'update':
      return [op.node.id]
    case 'delete':
      return [op.nodeId]
    case 'insert':
      return [op.node.id]
    case 'connect':
    case 'rewire':
      return [op.edge.from.nodeId, op.edge.to.nodeId]
    case 'disconnect':
      return []
  }
}

/**
 * True when `next` differs from `prior` only in the contract IDs of its ports. Indexer evidence
 * (sources, resolution) and key order are not design, so they do not count as a change.
 */
function contractsOnly(prior: CatalogNode | undefined, next: CatalogNode): boolean {
  if (!prior) return false
  const designed = (n: CatalogNode): string =>
    canonical({
      kind: n.kind,
      name: n.name,
      properties: n.properties,
      ports: [...n.ports]
        .map((port) => ({ ...port, contractId: undefined }))
        .sort((a, b) => a.id.localeCompare(b.id))
    })
  return designed(prior) === designed(next)
}

/** JSON with object keys sorted, so equal values compare equal however they were written. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

function nodeChange(op: CatalogOperation, name: (id: string) => string): string | null {
  switch (op.type) {
    case 'create':
    case 'insert':
      return `add ${op.node.kind} ${op.node.name}`
    case 'update':
      return `change ${op.node.kind} ${name(op.node.id)}`
    case 'delete':
      return `remove ${name(op.nodeId)}`
    default:
      return null
  }
}

/** Directories (or root-level files) holding source of the touched components and connections. */
function editableScope(
  baseline: CatalogGraph,
  after: CatalogGraph,
  touched: Set<string>,
  edges: CatalogEdge[]
): string[] {
  const nodes = new Map<string, CatalogNode>()
  for (const n of [...baseline.nodes, ...after.nodes]) if (touched.has(n.id)) nodes.set(n.id, n)
  const paths = new Set<string>()
  for (const s of [
    ...[...nodes.values()].flatMap((n) => n.sources),
    ...edges.flatMap((e) => e.sources)
  ])
    if (isRepoPath(s.path)) paths.add(s.path)
  const entries = [
    ...new Set([...paths].map((p) => (posix.dirname(p) === '.' ? p : posix.dirname(p))))
  ].sort()
  return entries.filter((e) => !entries.some((o) => o !== e && e.startsWith(`${o}/`)))
}

const isRepoPath = (p: string): boolean =>
  !!p && !posix.isAbsolute(p) && posix.normalize(p) === p && !p.split('/').includes('..')

function contextFor(repoDir: string, base: string, scope: string[]): SourceContext[] {
  const out: SourceContext[] = []
  let total = 0
  for (const entry of scope) {
    const listing = git(repoDir, ['ls-tree', '-r', '-l', '-z', base, '--', entry])
    for (const line of listing.split('\0').filter(Boolean)) {
      const [meta, path] = line.split('\t')
      const [mode, type, blob, size] = meta.split(/\s+/)
      if (type !== 'blob' || mode === '120000' || mode === '160000') continue
      if (Number(size) > MAX_FILE_BYTES) continue
      const text = git(repoDir, ['cat-file', 'blob', blob])
      if (text.includes('\0')) continue
      total += Buffer.byteLength(text)
      if (total > MAX_CONTEXT_BYTES)
        throw new ApprovalError(
          `The source under ${scope.join(', ')} is too large to hand to the coding agent.`
        )
      out.push({ path, blob, text })
    }
  }
  if (!out.length) throw new ApprovalError(`No source files under ${scope.join(', ')} at ${base}`)
  return out
}

function graphDigest(graph: CatalogGraph): string {
  const nodes = [...graph.nodes].map((n) => n.id).sort()
  const edges = [...graph.edges].map((e) => key(tripleOf(e))).sort()
  return sha256(JSON.stringify({ nodes, edges }))
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
