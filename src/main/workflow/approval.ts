/**
 * Freezes an approved catalog proposal into the packet the coding run and the local verifier both
 * read. Freezing re-derives every digest the verifier will check, so a packet that would be
 * refused later is refused here instead.
 */
import { spawnSync } from 'node:child_process'
import { posix } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { applyCatalogPatch, retryEventKey } from '../catalog/editing.ts'
import {
  VERIFIER_ID,
  lawSourceDigest,
  readBaselineGraph,
  semanticDigest,
  sha256
} from '../verification/refundRetry.ts'
import type {
  CatalogGraph,
  CatalogPatchResult,
  RetryBehavior,
  RetryEffect,
  RetryTransition
} from '../../shared/catalog'
import type { ApprovalRequest, ApprovedChange, SourceContext } from '../../shared/workflow'

const BEND_VERSION = 'bend 2.0.40'
const PROOF_FILE = 'PROOF.bend'
const BINDING_FILE = 'catalog.json'
const EVENTS_PER_STATE = 7

export class ApprovalError extends Error {}

export function previewProposal(
  request: Pick<ApprovalRequest, 'baseline' | 'patch'>
): CatalogPatchResult {
  return applyCatalogPatch(request.baseline, request.patch)
}

export interface FrozenApproval {
  approvalId: string
  packet: ApprovedChange
  /** The exact bytes `approvalId` hashes. The verifier reads these, not a re-serialization. */
  bytes: string
}

export function freezeApproval(repoDir: string, request: ApprovalRequest): FrozenApproval {
  const { baseline, patch, correlation } = request
  const base = baseline.commit.sha
  if (String(baseline.repository.id) !== correlation.projectId)
    throw new ApprovalError(
      `Proposal is for project ${correlation.projectId}, baseline is ${baseline.repository.id}`
    )
  if (git(repoDir, ['rev-parse', '--verify', `${base}^{commit}`]).trim() !== base)
    throw new ApprovalError(`Base ${base} is not a full commit SHA in ${repoDir}`)

  const preview = previewProposal(request)
  if (!preview.ok) throw new ApprovalError(`Proposal does not apply: ${preview.issue.message}`)
  const targets = new Set(patch.operations.map((op) => (op.type === 'update' ? op.node.id : '')))
  const target = [...targets][0]
  if (targets.size !== 1 || !target)
    throw new ApprovalError(
      'Local verification supports one update to a single state machine. This proposal needs a different verifier.'
    )
  const before = behaviorOf(baseline, target)
  const after = behaviorOf(preview.graph, target)
  const bindings = bindingsOf(preview.graph, target)

  const packet: ApprovedChange = {
    version: 1,
    repository: baseline.repository,
    baseCommit: base,
    catalog: {
      schemaVersion: baseline.schemaVersion,
      revision: baseline.revision,
      bindingPath: `${bindings.root}/${BINDING_FILE}`
    },
    targetComponentId: target,
    beforeDigest: semanticDigest(baseline, target),
    patch,
    afterDigest: semanticDigest(preview.graph, target),
    transitionIds: after.transitions.map((t) => t.id),
    bindings,
    obligations: [
      {
        id: 'native-typecheck',
        scope: `Trusted strict tsc config compiles ${bindings.caller.file} and its reducer types. Compilation only, not behavior.`
      },
      {
        id: 'graph-conformance',
        scope: `Generated reducer module agrees with the approved table on all ${after.states.length} x ${EVENTS_PER_STATE} state/event pairs; ${bindings.caller.export} forwards exactly the emitted RunAttempt commands on the first-success and three-failure traces.`
      },
      {
        id: 'bend-law',
        scope: `BendTT accepts the candidate proof of LAWS.bend#conforms: ${bindings.reducer.export} equals the approved function for every state/event pair of the generated domain.`
      }
    ],
    ...describeChange(before, after),
    openChoices: [
      'reducer structure and helper names',
      'logging',
      'caller internals beyond forwarding emitted attempts',
      'proof structure'
    ],
    toolchain: { bendVersion: BEND_VERSION, verifier: VERIFIER_ID, lawSourceDigest: '' },
    correlation,
    sourceContext: sourceContext(repoDir, base, bindings.root)
  }
  packet.toolchain.lawSourceDigest = lawSourceDigest(after, packet)

  // The committed binding at the base is what the verifier re-derives the approval from.
  let committed: CatalogGraph
  try {
    committed = readBaselineGraph(repoDir, packet)
  } catch (error) {
    throw new ApprovalError(`No catalog binding at ${base}:${packet.catalog.bindingPath}: ${error}`)
  }
  if (
    committed.revision !== baseline.revision ||
    semanticDigest(committed, target) !== packet.beforeDigest
  )
    throw new ApprovalError(
      `The previewed baseline for ${target} differs from ${packet.catalog.bindingPath} at ${base}`
    )

  const bytes = `${JSON.stringify(packet, null, 2)}\n`
  return { approvalId: sha256(bytes), packet, bytes }
}

function behaviorOf(graph: CatalogGraph, id: string): RetryBehavior {
  const node = graph.nodes.find((n) => n.id === id)
  if (node?.kind !== 'stateMachine' || !node.properties.behavior)
    throw new ApprovalError(`${id} is not a state machine with an executable behavior`)
  return node.properties.behavior
}

function bindingsOf(graph: CatalogGraph, id: string): ApprovedChange['bindings'] {
  const node = graph.nodes.find((n) => n.id === id)!
  const find = (ext: string): { path: string; field: string } => {
    const source = node.sources.find((s) => s.path.endsWith(ext) && s.field)
    if (!source?.field) throw new ApprovalError(`${id} has no ${ext} source with an export`)
    return { path: source.path, field: source.field }
  }
  const reducer = find('.bend')
  const caller = find('.ts')
  const root = posix.dirname(reducer.path)
  if (posix.dirname(caller.path) !== root)
    throw new ApprovalError(`${id} reducer and caller must share a directory`)
  return {
    root,
    reducer: { file: posix.basename(reducer.path), export: reducer.field },
    proof: { file: PROOF_FILE },
    caller: { file: posix.basename(caller.path), export: caller.field }
  }
}

const effectText = (e: RetryEffect): string =>
  e.type === 'RunAttempt' ? `RunAttempt(${e.attempt})` : 'NoEffect'
const rowText = (t: RetryTransition): string =>
  `${t.from} --${retryEventKey(t.event)}--> ${t.to} / ${effectText(t.effect)}`

/** The design decisions in words: what must change and what must stay. */
function describeChange(
  before: RetryBehavior,
  after: RetryBehavior
): Pick<ApprovedChange, 'requiredChanges' | 'preserved'> {
  const old = new Map(before.transitions.map((t) => [t.id, t]))
  const required = [
    ...after.states.filter((s) => !before.states.includes(s)).map((s) => `add state ${s}`),
    ...before.states.filter((s) => !after.states.includes(s)).map((s) => `remove state ${s}`)
  ]
  const unchanged: string[] = []
  for (const t of after.transitions) {
    const prior = old.get(t.id)
    if (!prior) required.push(`add ${t.id}: ${rowText(t)}`)
    else if (isDeepStrictEqual(prior, t)) unchanged.push(t.id)
    else required.push(`change ${t.id} to ${rowText(t)} (was ${rowText(prior)})`)
  }
  for (const id of old.keys())
    if (!after.transitions.some((t) => t.id === id)) required.push(`remove ${id}`)
  if (after.initialState !== before.initialState)
    required.push(`initial state becomes ${after.initialState}`)
  return {
    requiredChanges: required,
    preserved: [
      ...(unchanged.length ? [`${unchanged.join(', ')} are unchanged`] : []),
      'every unlisted state/event pair keeps the state and emits NoEffect'
    ]
  }
}

function sourceContext(repoDir: string, base: string, root: string): SourceContext[] {
  return git(repoDir, ['ls-tree', '-r', '-z', `${base}:${root}`])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const [meta, name] = entry.split('\t')
      const blob = meta.split(' ')[2]
      return { path: `${root}/${name}`, blob, text: git(repoDir, ['cat-file', 'blob', blob]) }
    })
}

export function git(cwd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): string {
  const r = spawnSync('git', args, { cwd, input, env, encoding: 'utf8', maxBuffer: 1 << 26 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`)
  return r.stdout
}
