import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CatalogGraph } from '../../src/shared/catalog'
import type { VerificationReport } from '../../src/shared/design'
import { DesignService } from '../../src/main/design/harness'
import { MemoryThreadHistory } from '../../src/main/design/history'
import type { ModelClient, ModelRequest, ModelResponse, Part } from '../../src/main/design/model'
import { DesignStore } from '../../src/main/design/store'
import { catalogFixture, refundCall, refundOperation } from '../fixtures/catalog/example'

const REFUNDS = [
  'export async function submitRefund(req: RefundRequest) {',
  '  validate(req)',
  '  return requestRefund(req)',
  '}'
].join('\n')

function observed(): CatalogGraph {
  const graph = catalogFixture()
  graph.nodes[1].sources = [
    { path: 'src/refunds.ts', span: { path: 'src/refunds.ts', start: { line: 0, character: 0 }, end: { line: 3, character: 1 } } }
  ]
  return graph
}

type Step = (request: ModelRequest) => Part[] | Promise<Part[]>

/** Plays scripted steps and records every request the harness sent. */
function scriptedModel(steps: Step[]): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  return {
    requests,
    async generate(request): Promise<ModelResponse> {
      requests.push(structuredClone({ ...request, signal: undefined }) as unknown as ModelRequest)
      const step = steps.shift()
      if (!step) throw new Error('Model script exhausted.')
      return { parts: await step(request), finishReason: 'STOP' }
    }
  }
}

const call = (name: string, args: Record<string, unknown>, sig?: string): Part => ({
  functionCall: { id: `${name}-${Math.random().toString(36).slice(2, 6)}`, name, args },
  ...(sig ? { thoughtSignature: sig } : {})
})

/** The evidenceId from the last read_source response the harness sent. */
const lastEvidence = (request: ModelRequest): string =>
  request.contents
    .flatMap((c) => c.parts)
    .filter((p) => p.functionResponse?.name === 'read_source')
    .map((p) => p.functionResponse!.response.evidenceId as string)
    .at(-1)!

const insertAudit = (evidenceIds: string[]): Record<string, unknown> => ({
  summary: 'Audit every refund between submission and the charge request.',
  evidenceIds,
  plan: {
    behavior: 'Every submitted refund is audited before the charge is requested.',
    steps: ['Add an audit step between submitRefund and requestRefund in src/refunds.ts.'],
    acceptance: ['A submitted refund produces one audit entry before the charge call.']
  },
  operations: [
    {
      type: 'insert',
      edgeId: 'submit-charge',
      node: refundOperation('audit', 'Audit refund'),
      incoming: refundCall('submit-audit', 'submit', 'audit'),
      outgoing: refundCall('audit-charge', 'audit', 'charge')
    }
  ]
})

const proposeTurn = (sig = 'sig-a'): Step[] => [
  () => [call('inspect_component', { componentId: 'submit' }, sig), call('read_source', { entityId: 'submit' })],
  (r) => [call('propose_graph_edit', insertAudit([lastEvidence(r)]), 'sig-b')],
  () => [{ text: 'I propose inserting an audit step on submit → charge.' }]
]

describe('DesignService', () => {
  let dir: string
  let reports: Map<string, VerificationReport>
  let history: MemoryThreadHistory
  let shared: DesignStore
  const make = (model: ModelClient, store = shared): DesignService =>
    new DesignService({
      store,
      observedCatalog: async (id) => (id === 42 ? observed() : null),
      readSource: async (_repo, sha, path) => (sha === 'a'.repeat(40) && path === 'src/refunds.ts' ? REFUNDS : null),
      verification: { latest: async (intentId) => reports.get(intentId) ?? null },
      history,
      model,
      models: ['gemini-4-carbon', 'gemini-4-hydrogen']
    })
  const turn = (service: DesignService, revision: number, extra: object = {}): ReturnType<DesignService['startTurn']> =>
    service.startTurn({
      projectId: 'refunds',
      threadId: 'thread-1',
      model: 'gemini-4-carbon',
      graph: { repositoryId: 42, commitSha: 'a'.repeat(40), revision },
      message: 'Add an audit step before we charge the refund.',
      selectedComponentId: 'submit',
      ...extra
    })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'diogenes-design-'))
    reports = new Map()
    history = new MemoryThreadHistory()
    shared = new DesignStore(dir)
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('gathers evidence, proposes an edit, and advances the draft exactly once on approval', async () => {
    const model = scriptedModel(proposeTurn())
    const service = make(model)
    await service.openProject('refunds', 42)

    const t = await turn(service, 0)
    expect(t.status).toBe('awaiting-approval')
    expect(t.selection).toMatchObject({ status: 'resolved', componentId: 'submit' })
    expect(t.toolCalls.map((c) => [c.name, c.ok])).toEqual([
      ['inspect_component', true],
      ['read_source', true],
      ['propose_graph_edit', true]
    ])
    expect(t.evidence[0]).toMatchObject({ entityId: 'submit', path: 'src/refunds.ts', commitSha: 'a'.repeat(40) })
    expect(t.evidence[0].excerpt).toContain('1: export async function submitRefund')
    // The selection reached the model, and its thought signatures came back verbatim within the turn.
    expect(model.requests[0].contents.at(-1)!.parts[0].text).toContain('Selected component: submit')
    expect(model.requests[1].contents.flatMap((c) => c.parts).find((p) => p.functionCall)?.thoughtSignature).toBe('sig-a')
    expect(model.requests[2].toolMode).toBe('NONE')

    let state = await service.getProject('refunds')
    const proposal = state.proposals[0]
    expect(proposal).toMatchObject({ status: 'pending', patch: { baseRevision: 0 } })
    expect(proposal.preview.components).toEqual([{ id: 'audit', name: 'Audit refund', change: 'added' }])
    expect(proposal.preview.connections.map((c) => `${c.change}:${c.id}`)).toEqual([
      'removed:submit-charge',
      'added:submit-audit',
      'added:audit-charge'
    ])
    expect(state.draft!.revision).toBe(0)

    const approved = await service.approve('refunds', proposal.id, 0)
    expect(approved).toMatchObject({ ok: true, alreadyApproved: false, draft: { revision: 1 } })
    const again = await service.approve('refunds', proposal.id, 0)
    expect(again).toMatchObject({ ok: true, alreadyApproved: true, draft: { revision: 1 } })

    state = await make(scriptedModel([]), new DesignStore(dir)).getProject('refunds') // reopened from disk
    expect(state.draft!.revision).toBe(1)
    expect(state.draft!.history).toHaveLength(1)
    expect(state.draft!.graph.edges.map((e) => e.id)).toEqual(['submit-audit', 'audit-charge'])
    expect(state.intents[0]).toMatchObject({ proposalId: proposal.id, fromRevision: 0, toRevision: 1 })
    expect(state.intents[0].evidence[0].excerpt).toContain('submitRefund')
  })

  it('never lets a stale proposal overwrite a newer draft', async () => {
    const service = make(scriptedModel([...proposeTurn(), ...proposeTurn()]))
    await service.openProject('refunds', 42)
    const first = await turn(service, 0)
    const second = await turn(service, 0)
    const [a, b] = (await service.getProject('refunds')).proposals
    expect([a.id, b.id]).toEqual([first.proposalId, second.proposalId])

    // A second proposal in the thread revises the first; only the revision can be approved.
    expect(a).toMatchObject({ status: 'stale', supersededBy: b.id })
    expect((await service.approve('refunds', b.id, 0)).ok).toBe(true)
    const draftAfterB = (await service.getProject('refunds')).draft!

    const stale = await service.approve('refunds', a.id, 1)
    expect(stale).toMatchObject({ ok: false, code: 'stale', currentRevision: 1 })
    const state = await service.getProject('refunds')
    expect(state.draft).toEqual(draftAfterB)

    // A client still showing revision 0 is told to reload; selection of a gone ID is explicit.
    expect((await turn(service, 0)).status).toBe('stale-graph')
    const missing = await make(scriptedModel([() => [{ text: 'Which component do you mean?' }]])).startTurn({
      projectId: 'refunds',
      threadId: 'thread-1',
      model: 'gemini-4-hydrogen',
      graph: { repositoryId: 42, commitSha: 'a'.repeat(40), revision: 1 },
      message: 'And here?',
      selectedComponentId: 'ghost'
    })
    expect(missing.selection).toMatchObject({ status: 'missing', componentId: 'ghost' })
    expect(missing.status).toBe('completed')
  })

  it('continues on another model, explains a failed verification, and keeps the intent', async () => {
    const service = make(scriptedModel(proposeTurn()))
    await service.openProject('refunds', 42)
    const proposalId = (await turn(service, 0)).proposalId!
    const approval = await service.approve('refunds', proposalId, 0)
    if (!approval.ok) throw new Error(approval.message)
    const intent = approval.intent
    reports.set(intent.id, {
      intentId: intent.id,
      runId: 'run-1',
      status: 'failed',
      checks: [
        { name: 'audit runs before charge', passed: false, detail: 'charge called first' },
        { name: 'refund still succeeds', passed: true }
      ],
      at: new Date().toISOString()
    })

    const model = scriptedModel([
      () => [call('read_verification', {})],
      () => [call('request_correction', { intentId: intent.id, instructions: 'Call audit() before requestRefund().' })],
      () => [{ text: 'The candidate charged before auditing; I asked for a correction.' }]
    ])
    const t = await make(model).startTurn({
      projectId: 'refunds',
      threadId: 'thread-1',
      model: 'gemini-4-hydrogen',
      graph: { repositoryId: 42, commitSha: 'a'.repeat(40), revision: 1 },
      message: 'The coding run came back. What went wrong?'
    })
    expect(t.status).toBe('completed')
    // The earlier turn replays as plain text, without the other model's signatures.
    const replay = model.requests[0].contents
    expect(replay.slice(0, 2).map((c) => c.role)).toEqual(['user', 'model'])
    expect(replay.flatMap((c) => c.parts).some((p) => p.thoughtSignature || p.functionCall)).toBe(false)
    expect(replay.at(-1)!.parts[0].text).toContain(`Approved intent ${intent.id}`)

    const state = await service.getProject('refunds')
    expect(state.corrections).toEqual([
      expect.objectContaining({ intentId: intent.id, runId: 'run-1', failedChecks: ['audit runs before charge'] })
    ])
    expect(state.intents).toEqual([intent])
  })

  it('cancels a running turn and reports a turn lost to a restart as interrupted', async () => {
    let started!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    const service = make(
      scriptedModel([
        (r) =>
          new Promise<Part[]>((_resolve, reject) => {
            started()
            r.signal.addEventListener('abort', () => reject(r.signal.reason))
          })
      ])
    )
    await service.openProject('refunds', 42)
    const pending = turn(service, 0)
    await running
    const { turns } = await service.getProject('refunds')
    expect(turns[0].status).toBe('running')
    expect(service.cancelTurn(turns[0].id)).toBe(true)
    expect(await pending).toMatchObject({ status: 'cancelled', error: 'Turn cancelled.' })

    // Simulate a crash mid-turn: the persisted turn says running, but no process owns it.
    await shared.update('refunds', (s) => {
      s.turns.push({ ...s.turns[0], id: 'turn-lost', status: 'running', finishedAt: undefined })
    })
    const reopened = await make(scriptedModel([]), new DesignStore(dir)).getProject('refunds')
    expect(reopened.turns.find((t) => t.id === 'turn-lost')!.status).toBe('interrupted')
    expect(reopened.draft!.revision).toBe(0)
    expect(reopened.proposals).toEqual([])
  })
})
