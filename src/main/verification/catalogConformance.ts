/**
 * Local verifier for general catalog changes (`CatalogApprovedChange`).
 *
 * It trusts nothing the coding agent said. From the exact candidate commit and its base it:
 * 1. checks the packet bytes against the approval ID, the candidate's parent against the frozen
 *    base, and that the candidate only changes paths inside the approved scope;
 * 2. materializes both trees from git into an isolated scratch directory (no install, no
 *    lifecycle scripts, no links) and type checks each with the TypeScript compiler API, so a
 *    candidate passes `native-typecheck` when it adds no diagnostic the base did not have;
 * 3. re-indexes both trees with the same pipeline that produced the observed catalog and checks
 *    every approved connection against them (`catalog-conformance`). An expectation the base
 *    already satisfies is not evidence and stays `unknown`, as do node changes the indexer
 *    cannot observe.
 * A changed state machine behavior without a proof binding gets `bend-law: unknown`.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { inScope } from '../coding/candidate.ts'
import { runIndexJob } from '../indexing/job.ts'
import { loadTypescript } from '../indexing/scip.ts'
import { git } from '../workflow/approval.ts'
import { CATALOG_VERIFIER_ID } from '../workflow/catalogApproval.ts'
import { WHITEBOARD_VERIFIER_ID } from '../workflow/whiteboardApproval.ts'
import type { ObligationResult, VerificationReport } from './refundRetry.ts'
import type { CatalogGraph } from '../../shared/catalog'
import type { SoftwareGraph } from '../../shared/indexing'
import type {
  ApprovedChange,
  CatalogApprovedChange,
  ConnectionExpectation,
  Outcome
} from '../../shared/workflow'

export interface CatalogVerifyInput {
  /** Git repository holding the candidate commit and its base. */
  repoDir: string
  packetPath: string
  trustedDigest: string
  candidate: string
}

const MAX_LISTED = 20

export async function verifyCatalogChange(input: CatalogVerifyInput): Promise<VerificationReport> {
  const bytes = readFileSync(input.packetPath)
  const packetDigest = createHash('sha256').update(bytes).digest('hex')
  const invalid = (reason: string): VerificationReport => ({
    valid: false,
    reason,
    candidateSha: input.candidate,
    packetDigest
  })
  if (packetDigest !== input.trustedDigest)
    return invalid('The approval packet bytes do not match the approval ID.')
  const packet = JSON.parse(bytes.toString('utf8')) as ApprovedChange
  // Whiteboard changes share the scope check and type check; they have no connections to re-index.
  if (
    !(packet.kind === 'catalog' && packet.toolchain.verifier === CATALOG_VERIFIER_ID) &&
    !(packet.kind === 'whiteboard' && packet.toolchain.verifier === WHITEBOARD_VERIFIER_ID)
  )
    return invalid(`Packet is not for ${CATALOG_VERIFIER_ID} or ${WHITEBOARD_VERIFIER_ID}.`)
  const { baseCommit: base } = packet
  const candidate = input.candidate
  if (!/^[0-9a-f]{40}$/.test(candidate)) return invalid('Candidate is not a full commit SHA.')
  try {
    const parents = git(input.repoDir, ['rev-list', '--parents', '-n', '1', candidate])
      .trim()
      .split(' ')
      .slice(1)
    if (parents.length !== 1 || parents[0] !== base)
      return invalid(`Candidate ${candidate} is not a single commit on the approved base ${base}.`)
  } catch (error) {
    return invalid(`Candidate ${candidate} is not in the candidate repository: ${error}`)
  }
  const changed = git(input.repoDir, ['diff', '--name-only', '-z', base, candidate])
    .split('\0')
    .filter(Boolean)
  const outside = changed.filter((p) => !inScope(p, packet.scope))
  if (outside.length)
    return invalid(`Candidate changes paths outside the approved scope: ${outside.join(', ')}`)

  const scratch = mkdtempSync(join(tmpdir(), 'dg-verify-'))
  try {
    const [baseTree, candTree] = await Promise.all([
      indexTree(input.repoDir, packet, base, join(scratch, 'base')),
      indexTree(input.repoDir, packet, candidate, join(scratch, 'candidate'))
    ])
    const ctx = { candidateSha: candidate, packetDigest }
    const obligations: ObligationResult[] = []
    for (const o of packet.obligations) {
      if (o.id === 'native-typecheck')
        obligations.push({ ...ctx, ...typecheck(baseTree.root, candTree.root, changed) })
      else if (o.id === 'catalog-conformance' && packet.kind === 'catalog')
        obligations.push({ ...ctx, ...conformance(packet, baseTree, candTree) })
      else
        obligations.push({
          ...ctx,
          id: o.id,
          outcome: 'unknown',
          tool: 'none',
          target: packet.targetComponentId,
          evidence: { ran: false, unknownReason: 'unsupported' },
          diagnostic: 'No proof binding exists for this behavior, so no proof was checked.'
        })
    }
    return {
      valid: true,
      overall: overall(obligations.map((o) => o.outcome)),
      scope: { requiredChanges: packet.requiredChanges, preserved: packet.preserved },
      candidateSha: candidate,
      packetDigest,
      checksRun: obligations.filter((o) => o.evidence.ran !== false).map((o) => o.id),
      obligations
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const overall = (outcomes: Outcome[]): Outcome =>
  outcomes.includes('fail') ? 'fail' : outcomes.every((o) => o === 'pass') ? 'pass' : 'unknown'

interface IndexedTree {
  /** Extracted source tree, as the indexer saw it. */
  root: string
  catalog: CatalogGraph
  status: SoftwareGraph['status']
}

/** Archives `sha` from git and runs the indexing job on it, exactly as for an observed commit. */
async function indexTree(
  repoDir: string,
  packet: Pick<CatalogApprovedChange, 'repository'>,
  sha: string,
  dir: string
): Promise<IndexedTree> {
  const archive = `${dir}.tar.gz`
  const prefix = `${packet.repository.fullName.replace('/', '-')}-${sha.slice(0, 7)}/`
  git(repoDir, ['archive', '--format=tar.gz', `--prefix=${prefix}`, '-o', archive, sha])
  const result = await runIndexJob({
    archivePath: archive,
    workDir: dir,
    outDir: join(dir, 'out'),
    repository: packet.repository,
    commit: { sha, ref: sha }
  })
  const graph = JSON.parse(await readFile(result.graphPath, 'utf8')) as SoftwareGraph
  if (!graph.catalog) throw new Error(`Indexing ${sha} produced no catalog.`)
  return { root: join(dir, 'src'), catalog: graph.catalog, status: graph.status }
}

type Check = Omit<ObligationResult, 'candidateSha' | 'packetDigest'>

/** New TypeScript diagnostics in the candidate relative to the base, by file, code and message. */
function typecheck(baseRoot: string, candRoot: string, changed: string[]): Check {
  const ts = loadTypescript()
  const tool = `typescript ${ts.version} (compiler API, noEmit)`
  const run = (root: string): { keys: string[]; lines: Map<string, string> } | null => {
    const config = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')
    // TypeScript returns '/'-separated paths while `root` uses the OS separator, so compare with
    // relative() (which accepts both) instead of startsWith: a config above the root doesn't count.
    const fromRoot = config ? relative(root, config) : '..'
    if (!config || fromRoot.startsWith('..') || isAbsolute(fromRoot)) return null
    const read = ts.readConfigFile(config, ts.sys.readFile)
    const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, root)
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: { ...parsed.options, noEmit: true, incremental: false, composite: false }
    })
    const keys: string[] = []
    const lines = new Map<string, string>()
    for (const d of ts.getPreEmitDiagnostics(program)) {
      const file = d.file ? relative(root, d.file.fileName).split(sep).join('/') : '(config)'
      const text = ts.flattenDiagnosticMessageText(d.messageText, ' ')
      const k = `${file}|TS${d.code}|${text}`
      keys.push(k)
      const at =
        d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null
      lines.set(k, `${file}${at ? `:${at.line + 1}:${at.character + 1}` : ''} TS${d.code}: ${text}`)
    }
    return { keys, lines }
  }
  const before = run(baseRoot)
  const after = run(candRoot)
  const target = changed.join(', ')
  if (!before || !after)
    return {
      id: 'native-typecheck',
      outcome: 'unknown',
      tool,
      target,
      evidence: { ran: false },
      diagnostic: 'No tsconfig.json at the repository root, so there is no type check to run.'
    }
  const remaining = new Map<string, number>()
  for (const k of before.keys) remaining.set(k, (remaining.get(k) ?? 0) + 1)
  const added: string[] = []
  for (const k of after.keys) {
    const n = remaining.get(k) ?? 0
    if (n > 0) remaining.set(k, n - 1)
    else added.push(after.lines.get(k)!)
  }
  return {
    id: 'native-typecheck',
    outcome: added.length ? 'fail' : 'pass',
    tool,
    target,
    evidence: {
      ran: true,
      baseDiagnostics: before.keys.length,
      candidateDiagnostics: after.keys.length,
      newDiagnostics: added.slice(0, MAX_LISTED)
    },
    ...(added.length && {
      diagnostic: `${added.length} new TypeScript diagnostic(s):\n${added.slice(0, MAX_LISTED).join('\n')}`
    })
  }
}

type ExpectationResult = Pick<ConnectionExpectation, 'id' | 'expect' | 'origin' | 'description'> & {
  outcome: Outcome
  atBase: boolean
  inCandidate: boolean
  sources?: string[]
}

/** Every approved connection against the re-indexed base and candidate. */
function conformance(packet: CatalogApprovedChange, base: IndexedTree, cand: IndexedTree): Check {
  const index = (g: CatalogGraph): Map<string, string[]> => {
    const m = new Map<string, string[]>()
    for (const e of g.edges)
      m.set(
        `${e.kind}:${e.from.nodeId}->${e.to.nodeId}`,
        e.sources.map((s) => `${s.path}${s.span ? `:${s.span.start.line + 1}` : ''}`)
      )
    return m
  }
  const atBase = index(base.catalog)
  const inCand = index(cand.catalog)
  const results: ExpectationResult[] = packet.connections.map((c) => {
    const k = `${c.kind}:${c.from}->${c.to}`
    const b = atBase.has(k)
    const n = inCand.has(k)
    const want = c.expect === 'present'
    // A required change the base already shows, or a connection the base never showed, proves
    // nothing about the candidate.
    const premise = c.origin === 'preserved' ? b : b !== want
    const outcome: Outcome = !premise ? 'unknown' : n === want ? 'pass' : 'fail'
    return {
      id: c.id,
      expect: c.expect,
      origin: c.origin,
      description: c.description,
      outcome,
      atBase: b,
      inCandidate: n,
      ...(n && { sources: inCand.get(k)!.slice(0, 5) })
    }
  })
  const failed = results.filter((r) => r.outcome === 'fail')
  const vacuous = results.filter((r) => r.outcome === 'unknown')
  const outcomes = [
    ...results.map((r) => r.outcome),
    ...packet.unobservable.map(() => 'unknown' as const)
  ]
  const outcome = overall(outcomes)
  const lines = [
    ...failed.map(
      (r) =>
        `${r.id}: expected ${r.description}, but the re-indexed candidate ${r.inCandidate ? 'still shows it' : 'does not show it'}`
    ),
    ...vacuous.map(
      (r) =>
        `${r.id}: the re-indexed base already ${r.atBase ? 'shows' : 'lacks'} it, so the candidate cannot prove it`
    ),
    ...packet.unobservable.map((u) => `not observable by the indexer: ${u}`)
  ]
  return {
    id: 'catalog-conformance',
    outcome,
    tool: `diogenes indexing (scip-typescript + catalog discovery), ${base.status}/${cand.status}`,
    target: packet.targetComponentId,
    evidence: {
      ran: true,
      expectations: results,
      unobservable: packet.unobservable,
      indexStatus: { base: base.status, candidate: cand.status }
    },
    ...(lines.length && { diagnostic: lines.join('\n') })
  }
}
