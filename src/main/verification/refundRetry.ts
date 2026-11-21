/**
 * Headless verifier for the refund retry fixture. It checks one hand-supplied candidate commit
 * against a frozen, digest-pinned approval. Expectations come only from the approved packet and
 * the baseline commit; candidate files are only ever the thing being checked.
 */
import { spawnSync } from 'node:child_process'
import { minimalEnv } from './childEnv.ts'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { applyCatalogPatch, retryEventKey } from '../catalog/editing.ts'
import type {
  CatalogGraph,
  RetryAttemptNumber,
  RetryBehavior,
  RetryEffect,
  RetryEvent
} from '../../shared/catalog'
import type { ApprovedChange, ObligationId, Outcome } from '../../shared/workflow'

export type { ApprovedChange }

export const VERIFIER_ID = 'diogenes-refund-retry-verifier/1'

export interface ObligationResult {
  id: ObligationId
  outcome: Outcome
  candidateSha: string
  packetDigest: string
  tool: string
  target: string
  evidence: Record<string, unknown>
  diagnostic?: string
}

export type VerificationReport =
  | {
      valid: true
      overall: Outcome
      /** A pass covers only the approved change and the named preserved behavior. */
      scope: { requiredChanges: string[]; preserved: string[] }
      candidateSha: string
      packetDigest: string
      checksRun: ObligationId[]
      obligations: ObligationResult[]
    }
  | { valid: false; reason: string; candidateSha?: string; packetDigest: string }

const TIMEOUT = { tool: 120_000, verdict: 900_000, driver: 30_000 }
const ATTEMPTS: readonly RetryAttemptNumber[] = [1, 2, 3]

/** The shared finite event domain, fixed here so a candidate cannot shrink it. */
const EVENTS: readonly RetryEvent[] = [
  { type: 'Start' },
  ...ATTEMPTS.map((attempt) => ({ type: 'Succeeded', attempt }) as const),
  ...ATTEMPTS.map((attempt) => ({ type: 'Failed', attempt }) as const)
]

/** First-attempt success, and three failures with a repeated and a late outcome. */
const TRACES: { id: string; events: RetryEvent[] }[] = [
  { id: 'first-attempt-success', events: [{ type: 'Start' }, { type: 'Succeeded', attempt: 1 }] },
  {
    id: 'three-failures-repeated-late',
    events: [
      { type: 'Start' },
      { type: 'Failed', attempt: 1 },
      { type: 'Failed', attempt: 1 },
      { type: 'Failed', attempt: 2 },
      { type: 'Failed', attempt: 3 },
      { type: 'Failed', attempt: 3 },
      { type: 'Succeeded', attempt: 2 }
    ]
  }
]

export const sha256 = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex')

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** Digest of what the machine means: identity and behavior, not evidence or ordering. */
export function semanticDigest(graph: CatalogGraph, id: string): string {
  const behavior = machine(graph, id)
  return sha256(
    canonical({
      id,
      kind: 'stateMachine',
      behavior: {
        ...behavior,
        states: [...behavior.states].sort(),
        transitions: [...behavior.transitions].sort((a, b) => (a.id < b.id ? -1 : 1))
      }
    })
  )
}

class InvalidRun extends Error {}

function machine(graph: CatalogGraph, id: string): RetryBehavior {
  const node = graph.nodes.find((n) => n.id === id)
  if (node?.kind !== 'stateMachine' || !node.properties.behavior)
    throw new InvalidRun(`${id} is not a state machine with a behavior payload`)
  return node.properties.behavior
}

interface Step {
  state: string
  effect: RetryEffect
}

/** The approved step function: listed rows, otherwise keep the state and emit NoEffect. */
function approvedStep(behavior: RetryBehavior, state: string, event: RetryEvent): Step {
  const key = retryEventKey(event)
  const row = behavior.transitions.find((t) => t.from === state && retryEventKey(t.event) === key)
  return row ? { state: row.to, effect: row.effect } : { state, effect: { type: 'NoEffect' } }
}

// Bend encoding, shared by the generated domain, the law and the generated ES module.
type BendValue = { $: string; n?: BendValue; state?: BendValue; effect?: BendValue }
const bAttempt = (n: RetryAttemptNumber): BendValue => ({ $: `A${n}` })
const bState = (s: string): BendValue => ({ $: `S${s}` })
const bEvent = (e: RetryEvent): BendValue =>
  e.type === 'Start' ? { $: 'EStart' } : { $: `E${e.type}`, n: bAttempt(e.attempt) }
const bEffect = (e: RetryEffect): BendValue =>
  e.type === 'NoEffect' ? { $: 'NoEffect' } : { $: 'RunAttempt', n: bAttempt(e.attempt) }
const bStep = (r: Step): BendValue => ({
  $: 'RetryStep',
  state: bState(r.state),
  effect: bEffect(r.effect)
})

const term = (v: BendValue): string =>
  `D.${v.$}{${[v.state, v.effect, v.n]
    .filter((f): f is BendValue => f !== undefined)
    .map(term)
    .join(', ')}}`

const show = (v: unknown): string => {
  const s = v as BendValue | undefined
  if (!s?.state || !s.effect) return JSON.stringify(v)
  return `${s.state.$.slice(1)} / ${s.effect.n ? `RunAttempt(${s.effect.n.$.slice(1)})` : s.effect.$}`
}

export function generateDomainSource(behavior: RetryBehavior): string {
  return `import Base

# Generated by ${VERIFIER_ID} from the approved graph.

type RetryAttempt is Data:
${ATTEMPTS.map((n) => `  A${n}{}`).join('\n')}

type RetryState is Data:
${behavior.states.map((s) => `  S${s}{}`).join('\n')}

type RetryEvent is Data:
  EStart{}
  ESucceeded{n: RetryAttempt}
  EFailed{n: RetryAttempt}

type RetryEffect is Data:
  NoEffect{}
  RunAttempt{n: RetryAttempt}

type RetryStep is Data:
  RetryStep{state: RetryState, effect: RetryEffect}
`
}

export function generateLawSource(
  behavior: RetryBehavior,
  reducer: { file: string; export: string }
): string {
  const cases = behavior.states.flatMap((s) =>
    EVENTS.map(
      (e) =>
        `    case ${term(bState(s))} ${term(bEvent(e))}:\n      ${term(bStep(approvedStep(behavior, s, e)))}`
    )
  )
  return `import Base
import ./domain.bend as D
import ./${reducer.file} as R

# Generated by ${VERIFIER_ID} from the approved graph. Do not edit.
# Transitions: ${behavior.transitions.map((t) => t.id).join(', ')}
# Every other state/event pair keeps its state and emits NoEffect.

def approved(s: D.RetryState, e: D.RetryEvent) -> D.RetryStep:
  match s e:
${cases.join('\n')}

law conforms:
  for s: D.RetryState
  for e: D.RetryEvent
  {R.${reducer.export}(s, e) == approved(s, e) : D.RetryStep}
`
}

export const lawSourceDigest = (behavior: RetryBehavior, packet: ApprovedChange): string =>
  sha256(
    `${generateDomainSource(behavior)}\0${generateLawSource(behavior, packet.bindings.reducer)}`
  )

/** Bend source without comments or blank lines, for comparing a committed domain. */
const bendBody = (source: string): string =>
  source
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trimEnd())
    .filter(Boolean)
    .join('\n')

/** The manual catalog binding at the baseline. A commit cannot name itself, so the SHA is added here. */
export function readBaselineGraph(repoDir: string, packet: ApprovedChange): CatalogGraph {
  const json = JSON.parse(
    git(repoDir, ['show', `${packet.baseCommit}:${packet.catalog.bindingPath}`])
  )
  return { ...json, commit: { sha: packet.baseCommit, ref: packet.baseCommit } }
}

function git(repoDir: string, args: string[]): string {
  const r = spawnSync('git', args, {
    cwd: repoDir,
    env: minimalEnv(),
    encoding: 'utf8',
    maxBuffer: 1 << 26
  })
  if (r.status !== 0) throw new InvalidRun(`git ${args.join(' ')}: ${r.stderr.trim()}`)
  return r.stdout
}

const resolveCommit = (repoDir: string, rev: string): string =>
  git(repoDir, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).trim()

/** Re-derives the approved behavior from the pinned baseline and checks every frozen digest. */
function approvedBehavior(
  repoDir: string,
  packet: ApprovedChange,
  candidateSha: string
): RetryBehavior {
  const target = packet.targetComponentId
  if (packet.version !== 1 || packet.toolchain.verifier !== VERIFIER_ID)
    throw new InvalidRun('Packet was approved for a different verifier or version')
  if (resolveCommit(repoDir, packet.baseCommit) !== packet.baseCommit)
    throw new InvalidRun(
      `Baseline ${packet.baseCommit} is not a full commit SHA in this repository`
    )
  const ancestor = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', packet.baseCommit, candidateSha],
    {
      cwd: repoDir,
      env: minimalEnv()
    }
  )
  if (ancestor.status !== 0)
    throw new InvalidRun(
      `Candidate ${candidateSha} does not descend from baseline ${packet.baseCommit}`
    )
  const ops = packet.patch.operations
  if (!ops.length || ops.some((op) => op.type !== 'update' || op.node.id !== target))
    throw new InvalidRun(`Patch must only update ${target}`)
  const baseline = readBaselineGraph(repoDir, packet)
  if (
    baseline.schemaVersion !== packet.catalog.schemaVersion ||
    baseline.revision !== packet.catalog.revision ||
    baseline.repository.id !== packet.repository.id
  )
    throw new InvalidRun(
      'Baseline catalog repository, schema version or revision changed since approval'
    )
  if (semanticDigest(baseline, target) !== packet.beforeDigest)
    throw new InvalidRun(`Baseline ${target} does not match the approved before digest`)
  const patched = applyCatalogPatch(baseline, packet.patch)
  if (!patched.ok) throw new InvalidRun(`Approved patch does not apply: ${patched.issue.message}`)
  if (semanticDigest(patched.graph, target) !== packet.afterDigest)
    throw new InvalidRun('Patched component does not match the approved after digest')
  const behavior = machine(patched.graph, target)
  if (
    !isDeepStrictEqual(
      behavior.transitions.map((t) => t.id),
      packet.transitionIds
    )
  )
    throw new InvalidRun('Approved transition IDs do not match the patched behavior')
  if (lawSourceDigest(behavior, packet) !== packet.toolchain.lawSourceDigest)
    throw new InvalidRun('Generated law source does not match the approved law digest')
  return behavior
}

interface Context {
  bend: string
  packet: ApprovedChange
  behavior: RetryBehavior
  candidateSha: string
  packetDigest: string
  workspace: string
}

export function verifyRefundRetry(options: {
  repoDir: string
  packetPath: string
  /** SHA-256 of the approved packet bytes, supplied separately from the packet. */
  trustedDigest: string
  /** A commit in repoDir, supplied by hand. */
  candidate: string
  /** Pinned Bend binary. `bend --verdict` finds the BendTT kernel through $BENDTT. */
  bend: string
}): VerificationReport {
  const bytes = readFileSync(options.packetPath)
  const packetDigest = sha256(bytes)
  let candidateSha: string | undefined
  const workspace = mkdtempSync(join(tmpdir(), 'diogenes-refund-verify-'))
  try {
    if (packetDigest !== options.trustedDigest.trim())
      throw new InvalidRun(`Packet digest ${packetDigest} does not match the approved digest`)
    const packet = JSON.parse(bytes.toString('utf8')) as ApprovedChange
    candidateSha = resolveCommit(options.repoDir, options.candidate)
    const behavior = approvedBehavior(options.repoDir, packet, candidateSha)
    const ctx: Context = {
      bend: options.bend,
      packet,
      behavior,
      candidateSha,
      packetDigest,
      workspace
    }
    const committedDomain = extractCandidate(options.repoDir, ctx)
    const bendVersion = spawnSync(options.bend, ['version'], { env: bendEnv(), encoding: 'utf8' }).stdout?.trim()
    const bendIssue =
      bendVersion === packet.toolchain.bendVersion
        ? undefined
        : `Bend at ${options.bend} reports ${bendVersion || 'nothing'}; the approval pins ${packet.toolchain.bendVersion}`
    const obligations = [
      typecheck(ctx),
      conformance(ctx, bendIssue, committedDomain),
      law(ctx, bendIssue)
    ]
    const outcomes = obligations.map((o) => o.outcome)
    return {
      valid: true,
      overall: outcomes.includes('fail')
        ? 'fail'
        : outcomes.every((o) => o === 'pass')
          ? 'pass'
          : 'unknown',
      scope: { requiredChanges: packet.requiredChanges, preserved: packet.preserved },
      candidateSha,
      packetDigest,
      checksRun: obligations.filter((o) => o.evidence.ran).map((o) => o.id),
      obligations
    }
  } catch (error) {
    if (!(error instanceof InvalidRun)) throw error
    return { valid: false, reason: error.message, candidateSha, packetDigest }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

const src = (ctx: Context, file = ''): string => join(ctx.workspace, 'src', file)
const out = (ctx: Context, file = ''): string => join(ctx.workspace, 'run', file)

function result(
  ctx: Context,
  id: ObligationId,
  outcome: Outcome,
  tool: string,
  target: string,
  evidence: Record<string, unknown>,
  diagnostic?: string
): ObligationResult {
  const { candidateSha, packetDigest } = ctx
  return { id, outcome, candidateSha, packetDigest, tool, target, evidence, diagnostic }
}

/**
 * Writes the exact candidate files to scratch, then replaces verifier-owned files with sources
 * generated from the approval. Returns the committed domain so conformance can compare it.
 */
function extractCandidate(repoDir: string, ctx: Context): string | undefined {
  const tree = `${ctx.candidateSha}:${ctx.packet.bindings.root}`
  // Regular files only: a symlink could redirect the trusted writes below.
  for (const entry of git(repoDir, ['ls-tree', '-r', '-z', tree]).split('\0').filter(Boolean)) {
    const mode = entry.split(' ')[0]
    if (mode !== '100644' && mode !== '100755')
      throw new InvalidRun(`Candidate snapshot has a non-regular entry: ${entry.split('\t')[1]}`)
  }
  mkdirSync(src(ctx), { recursive: true })
  const tar = spawnSync('git', ['archive', '--format=tar', tree], {
    cwd: repoDir,
    env: minimalEnv(),
    maxBuffer: 1 << 26
  })
  const untar = spawnSync('tar', ['-x', '-C', src(ctx)], { env: minimalEnv(), input: tar.stdout })
  if (tar.status !== 0 || untar.status !== 0) throw new InvalidRun(`Could not extract ${tree}`)
  const domain = src(ctx, 'domain.bend')
  const committed = existsSync(domain) ? readFileSync(domain, 'utf8') : undefined
  for (const owned of ['package.json', 'tsconfig.json', 'reducer.mjs'])
    rmSync(src(ctx, owned), { force: true })
  writeFileSync(domain, generateDomainSource(ctx.behavior))
  writeFileSync(src(ctx, 'LAWS.bend'), generateLawSource(ctx.behavior, ctx.packet.bindings.reducer))
  writeFileSync(join(ctx.workspace, 'package.json'), '{ "type": "module", "private": true }\n')
  return committed
}

function typecheck(ctx: Context): ObligationResult {
  const caller = ctx.packet.bindings.caller.file
  const target = `${ctx.packet.bindings.root}/${caller}`
  const require = createRequire(import.meta.url)
  const tsc = require.resolve('typescript/bin/tsc')
  const tool = `typescript ${(require('typescript/package.json') as { version: string }).version}`
  const compilerOptions = {
    strict: true,
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    rootDir: 'src',
    outDir: 'run',
    types: [],
    noEmitOnError: false
  }
  writeFileSync(
    join(ctx.workspace, 'tsconfig.verify.json'),
    JSON.stringify({ compilerOptions, files: [`src/${caller}`] })
  )
  const command = 'tsc -p tsconfig.verify.json --pretty false'
  const r = spawnSync(process.execPath, [tsc, ...command.split(' ').slice(1)], {
    cwd: ctx.workspace,
    env: minimalEnv(),
    encoding: 'utf8',
    timeout: TIMEOUT.tool
  })
  const evidence = { ran: true, command, compilerOptions }
  const diagnostic = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  if (r.status === 0) return result(ctx, 'native-typecheck', 'pass', tool, target, evidence)
  // Killed, or non-zero without diagnostics: the compiler reached no verdict.
  const outcome = diagnostic && r.status !== null ? 'fail' : 'unknown'
  return result(
    ctx,
    'native-typecheck',
    outcome,
    tool,
    target,
    evidence,
    diagnostic || 'tsc did not finish'
  )
}

interface DriverOutput {
  pairs: { actual?: unknown; error?: string }[]
  callerError?: string
  traces: {
    sink: unknown[]
    calls: { state: unknown; event: unknown; output: unknown }[]
    finalState?: unknown
    error?: string
  }[]
}

function conformance(
  ctx: Context,
  bendIssue: string | undefined,
  committedDomain: string | undefined
): ObligationResult {
  const { reducer, caller, root } = ctx.packet.bindings
  const target = `${root}/${reducer.file}#${reducer.export} via ${caller.file}#${caller.export}`
  const tool = `${ctx.packet.toolchain.bendVersion} + node ${process.version}`
  const evidence: Record<string, unknown> = { ran: false }
  const done = (outcome: Outcome, diagnostic?: string): ObligationResult =>
    result(ctx, 'graph-conformance', outcome, tool, target, evidence, diagnostic)
  const approvedDomain = bendBody(generateDomainSource(ctx.behavior))
  if (committedDomain === undefined || bendBody(committedDomain) !== approvedDomain)
    return done(
      'fail',
      `${root}/domain.bend does not match the domain generated from the approved graph`
    )
  if (bendIssue) return done('unknown', bendIssue)

  // The runtime ES module comes from the same candidate reducer the law checks.
  mkdirSync(out(ctx), { recursive: true })
  const compiled = spawnSync(ctx.bend, [reducer.file, '-o', out(ctx, 'compiled-reducer.mjs')], {
    cwd: src(ctx),
    env: bendEnv(),
    encoding: 'utf8',
    timeout: TIMEOUT.tool
  })
  evidence.ran = true
  if (compiled.status === null) return done('unknown', 'bend did not finish compiling the reducer')
  if (compiled.status !== 0) return done('fail', `${compiled.stdout}${compiled.stderr}`.trim())
  evidence.runtimeModuleDigest = sha256(readFileSync(out(ctx, 'compiled-reducer.mjs')))

  const pairs = ctx.behavior.states.flatMap((state) => EVENTS.map((event) => ({ state, event })))
  evidence.pairsChecked = pairs.length
  evidence.traces = TRACES.map((t) => t.id)
  const observed = runDriver(ctx, pairs)
  if (typeof observed === 'string')
    return done(observed === 'timeout' ? 'unknown' : 'fail', observed)

  const mismatches: string[] = []
  pairs.forEach(({ state, event }, i) => {
    const expected = bStep(approvedStep(ctx.behavior, state, event))
    const got = observed.pairs[i]
    if (got?.error !== undefined || !isDeepStrictEqual(got?.actual, expected))
      mismatches.push(
        `pair ${state}/${retryEventKey(event)}: expected ${show(expected)}, actual ${got?.error ?? show(got?.actual)}`
      )
  })
  if (observed.callerError) mismatches.push(`caller did not load: ${observed.callerError}`)
  else
    TRACES.forEach((trace, i) =>
      mismatches.push(...checkTrace(ctx.behavior, trace, observed.traces[i]))
    )
  return mismatches.length ? done('fail', mismatches.join('\n')) : done('pass')
}

function checkTrace(
  behavior: RetryBehavior,
  trace: (typeof TRACES)[number],
  got: DriverOutput['traces'][number] | undefined
): string[] {
  const at = `trace ${trace.id}`
  if (!got) return [`${at}: no result`]
  const problems = got.error ? [`${at}: caller threw ${got.error}`] : []
  let state = behavior.initialState
  const attempts: number[] = []
  trace.events.forEach((event, i) => {
    const step = approvedStep(behavior, state, event)
    const call = got.calls[i]
    const expected = bStep(step)
    const input = { state: bState(state), event: bEvent(event) }
    if (
      !call ||
      !isDeepStrictEqual({ state: call.state, event: call.event }, input) ||
      !isDeepStrictEqual(call.output, expected)
    )
      problems.push(
        `${at}: event ${i} ${state}/${retryEventKey(event)} expected ${show(expected)}, actual ${call ? show(call.output) : 'no reducer call'}`
      )
    if (step.effect.type === 'RunAttempt') attempts.push(step.effect.attempt)
    state = step.state
  })
  const emitted = got.calls.flatMap((c) => {
    const n = (c.output as BendValue | undefined)?.effect?.n
    return n ? [Number(n.$.slice(1))] : []
  })
  if (got.calls.length !== trace.events.length)
    problems.push(`${at}: ${got.calls.length} reducer calls for ${trace.events.length} events`)
  if (!isDeepStrictEqual(got.sink, emitted))
    problems.push(
      `${at}: sink got ${JSON.stringify(got.sink)}, reducer emitted ${JSON.stringify(emitted)}`
    )
  if (!isDeepStrictEqual(got.sink, attempts))
    problems.push(
      `${at}: expected attempts ${JSON.stringify(attempts)}, actual ${JSON.stringify(got.sink)}`
    )
  if (!got.error && !isDeepStrictEqual(got.finalState, bState(state)))
    problems.push(`${at}: expected final state ${state}, actual ${JSON.stringify(got.finalState)}`)
  return problems
}

/**
 * Runs candidate code in a child process. The caller's `./reducer.mjs` import resolves to a
 * recording wrapper around the freshly compiled module. Only observations come back.
 */
function runDriver(
  ctx: Context,
  pairs: { state: string; event: RetryEvent }[]
): DriverOutput | string {
  const { reducer, caller } = ctx.packet.bindings
  const step = JSON.stringify(reducer.export)
  const callerJs = JSON.stringify(`./run/${caller.file.replace(/\.ts$/, '.js')}`)
  writeFileSync(
    out(ctx, 'reducer.mjs'),
    `import compiled from './compiled-reducer.mjs'
const clone = (v) => JSON.parse(JSON.stringify(v))
export default {
  [${step}](state, event) {
    const input = clone({ state, event })
    const output = compiled[${step}](state, event)
    globalThis[Symbol.for('diogenes.reducerLog')].push({ ...input, output: clone(output) })
    return output
  }
}
`
  )
  writeFileSync(
    join(ctx.workspace, 'driver.mjs'),
    `import { readFileSync, writeFileSync } from 'node:fs'
const job = JSON.parse(readFileSync('driver-input.json', 'utf8'))
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const result = { pairs: [], traces: [] }
const compiled = (await import('./run/compiled-reducer.mjs')).default
for (const p of job.pairs) {
  try { result.pairs.push({ actual: clone(compiled[${step}](p.state, p.event)) }) }
  catch (e) { result.pairs.push({ error: String(e) }) }
}
const log = (globalThis[Symbol.for('diogenes.reducerLog')] = [])
let create
try {
  create = (await import(${callerJs}))[${JSON.stringify(caller.export)}]
  if (typeof create !== 'function') throw new Error('caller export is not a function')
} catch (e) { result.callerError = String(e) }
if (create) for (const events of job.traces) {
  const sink = []
  log.length = 0
  try {
    const retry = create({ runAttempt: (n) => { sink.push(n) } })
    for (const e of events) retry.dispatch(clone(e))
    result.traces.push({ sink: clone(sink), calls: clone(log), finalState: clone(retry.state) })
  } catch (e) { result.traces.push({ sink: clone(sink), calls: clone(log), error: String(e) }) }
}
writeFileSync('driver-output.json', JSON.stringify(result))
`
  )
  writeFileSync(
    join(ctx.workspace, 'driver-input.json'),
    JSON.stringify({
      pairs: pairs.map((p) => ({ state: bState(p.state), event: bEvent(p.event) })),
      traces: TRACES.map((t) => t.events.map(bEvent))
    })
  )
  const r = spawnSync(process.execPath, ['driver.mjs'], {
    cwd: ctx.workspace,
    // The driver imports the candidate's caller: it gets no inherited variables at all.
    env: minimalEnv(),
    encoding: 'utf8',
    timeout: TIMEOUT.driver
  })
  if (r.status === null) return 'timeout'
  const output = join(ctx.workspace, 'driver-output.json')
  if (r.status !== 0 || !existsSync(output)) return `driver failed: ${r.stdout}${r.stderr}`.trim()
  return JSON.parse(readFileSync(output, 'utf8')) as DriverOutput
}

function law(ctx: Context, bendIssue: string | undefined): ObligationResult {
  const { proof, reducer, root } = ctx.packet.bindings
  const target = `${root}/${proof.file} proves LAWS.bend#conforms over ${reducer.file}#${reducer.export}`
  const tool = `${ctx.packet.toolchain.bendVersion} --verdict (BendTT)`
  const digest = (file: string): string | undefined =>
    existsSync(src(ctx, file)) ? sha256(readFileSync(src(ctx, file))) : undefined
  const evidence: Record<string, unknown> = {
    ran: false,
    reducerDigest: digest(reducer.file),
    lawDigest: digest('LAWS.bend'),
    proofDigest: digest(proof.file),
    lawSourceDigest: ctx.packet.toolchain.lawSourceDigest,
    bendtt: process.env.BENDTT ?? null
  }
  const done = (outcome: Outcome, diagnostic?: string): ObligationResult =>
    result(ctx, 'bend-law', outcome, tool, target, evidence, diagnostic)
  if (bendIssue) return done('unknown', bendIssue)
  if (!evidence.proofDigest)
    return done('fail', `Candidate has no ${proof.file}; the law stays open`)
  const r = spawnSync(ctx.bend, [proof.file, '--verdict'], {
    cwd: src(ctx),
    env: bendEnv(),
    encoding: 'utf8',
    timeout: TIMEOUT.verdict
  })
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  evidence.ran = true
  evidence.verdict = text.split('\n')[0]
  if (r.status === 0 && text === 'ALL PROOFS CHECK') return done('pass')
  if (r.status !== null && r.status !== 0 && text.startsWith('SOME PROOFS FAIL'))
    return done('fail', text)
  return done('unknown', `BendTT returned no verdict: ${text || 'no output'}`)
}

/** The pinned Bend binary: $DIOGENES_BEND, or `bend` on PATH. */
export const pinnedBend = (): string => process.env.DIOGENES_BEND ?? 'bend'

/** Bend needs only the BendTT kernel location on top of the minimal environment. */
const bendEnv = (): NodeJS.ProcessEnv => minimalEnv({ BENDTT: process.env.BENDTT })
