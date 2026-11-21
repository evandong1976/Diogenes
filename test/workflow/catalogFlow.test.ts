/**
 * A real repository edit through the integrated backend, headless, with only provider calls faked.
 *
 * A small Electron repository is committed to a scratch "remote" and indexed with the real
 * pipeline. The design agent (scripted) proposes rewiring the preload's `orders` call from
 * `orders:list` to `orders:archived`; approval fetches the exact base commit by SHA from the remote
 * (no configured clone) and freezes a catalog packet. The managed agent (the Antigravity fake)
 * first returns a candidate that compiles but keeps the old connection; the design agent reads the
 * local verdict and requests a bounded correction in the same handoff, and that turn fixes it. Each candidate is materialized, type checked and
 * re-indexed locally, and its verdict is persisted. A fresh backend on the same data reopens it all.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createBackend, type AgentBackend } from '../../src/main/backend/backend'
import { GitMirror } from '../../src/main/backend/repos'
import { createAntigravityProvider } from '../../src/main/coding/antigravity'
import { DESIGN_MODELS } from '../../src/main/design'
import { geminiModelClient, type ModelClient, type Part } from '../../src/main/design/model'
import { runIndexJob } from '../../src/main/indexing/job'
import { catalogVerifier, refundRetryVerifier } from '../../src/main/workflow/verifiers'
import type { CatalogGraph } from '../../src/shared/catalog'
import type { SoftwareGraph } from '../../src/shared/indexing'
import type {
  CatalogApprovedChange,
  HandoffRecord,
  ObligationVerdict
} from '../../src/shared/workflow'
import { FakeProvider, FakeServer, type AgentTurn } from '../coding/fakeProvider'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const fixture = join(repoRoot, 'test/fixtures/orders-ipc')
const exportScript = readFileSync(join(repoRoot, 'src/main/coding/export-candidate.mjs'), 'utf8')
const PROJECT = '4242'
const REPO = { id: 4242, fullName: 'octo/orders' }
const MODEL = 'test-model'
const CALLER = 'generic:ts:src/preload.ts#orders0:'
const LIST = 'operation:electron-ipc:.:orders:list'
const ARCHIVED = 'operation:electron-ipc:.:orders:archived'
const EDGE = `calls:${CALLER}->${LIST}`
const CONTRACT = 'data-contract:orders-archived'
const LATEST_INTENT = '<intent from read_verification>'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** The fixture committed to a scratch remote, and its catalog from the real indexer. */
async function remote(): Promise<{ dir: string; base: string; baseline: CatalogGraph }> {
  const dir = mkdtempSync(join(tmpdir(), 'dg-remote-'))
  cpSync(fixture, dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.email=t@diogenes.invalid', '-c', 'user.name=t', 'commit', '-qm', 'base')
  const base = git(dir, 'rev-parse', 'HEAD')
  const work = mkdtempSync(join(tmpdir(), 'dg-index-'))
  const archive = join(work, 'base.tar.gz')
  git(
    dir,
    'archive',
    '--format=tar.gz',
    `--prefix=octo-orders-${base.slice(0, 7)}/`,
    '-o',
    archive,
    base
  )
  const job = await runIndexJob({
    archivePath: archive,
    workDir: join(work, 'job'),
    outDir: join(work, 'out'),
    repository: REPO,
    commit: { sha: base, ref: 'main' }
  })
  const graph = JSON.parse(await readFile(job.graphPath, 'utf8')) as SoftwareGraph
  return { dir, base, baseline: graph.catalog! }
}

/** Proposes the rewire, then replies. */
function scriptedModel(baseline: CatalogGraph): ModelClient {
  const steps: Part[][] = [
    [
      {
        functionCall: {
          id: 'propose-1',
          name: 'propose_graph_edit',
          args: {
            summary: 'The preload orders call should read archived orders.',
            operations: [
              // The editor connects ports only once both declare a contract.
              {
                type: 'create',
                node: {
                  id: CONTRACT,
                  kind: 'dataContract',
                  name: 'Archived orders',
                  resolution: 'declared',
                  properties: { format: 'typescript' },
                  ports: [],
                  sources: []
                }
              },
              // As the live model writes them: no sources or resolution, keys in its own order.
              ...[CALLER, ARCHIVED].map((id) => {
                const { kind, name, properties, ports } = baseline.nodes.find((n) => n.id === id)!
                return {
                  type: 'update',
                  node: {
                    properties: Object.fromEntries(Object.entries(properties).reverse()),
                    ports: ports.map((p) => ({ ...p, contractId: CONTRACT })),
                    name,
                    kind,
                    id
                  }
                }
              }),
              {
                type: 'rewire',
                edge: {
                  id: EDGE,
                  kind: 'calls',
                  from: { nodeId: CALLER, portId: 'out:electron-ipc' },
                  to: { nodeId: ARCHIVED, portId: 'in' }
                }
              }
            ]
          }
        }
      }
    ],
    [{ text: 'Proposed rewiring orders to orders:archived.' }],
    // The correction turn: read the local verdict, then ask for a bounded fix.
    [{ functionCall: { id: 'verify-1', name: 'read_verification', args: {} } }],
    [
      {
        functionCall: {
          id: 'fix-1',
          name: 'request_correction',
          args: {
            intentId: LATEST_INTENT,
            instructions:
              'catalog-conformance failed: the preload orders call must invoke orders:archived, not orders:list.'
          }
        }
      }
    ],
    [{ text: 'Asked the coding agent to call orders:archived.' }]
  ]
  return {
    async generate({ contents }) {
      const parts = steps.shift()
      if (!parts) throw new Error('Model script exhausted.')
      // Names the intent read_verification returned, as a model would.
      const read = contents
        .flatMap((c) => c.parts)
        .findLast((p) => p.functionResponse?.name === 'read_verification')
      const intent = (read?.functionResponse?.response.intent as { id: string } | undefined)?.id
      const resolved = JSON.parse(JSON.stringify(parts).replaceAll(LATEST_INTENT, intent ?? ''))
      return { parts: resolved, finishReason: 'STOP' }
    }
  }
}

const preload = (channel: string, note = ''): string =>
  [
    "import { ipcRenderer } from 'electron'",
    '',
    'export const api = {',
    `  ${note}orders: (): Promise<string[]> => ipcRenderer.invoke('${channel}')`,
    '}',
    ''
  ].join('\n')

/** Compiles, touches the right file, and keeps the old connection. */
const missesConnection: AgentTurn = ({ repo, exportCandidate }) => {
  writeFileSync(
    join(repo, 'src/preload.ts'),
    preload('orders:list', '// Orders for the list view.\n  ')
  )
  exportCandidate()
}
/** The follow-up turn in the same workspace makes the approved connection. */
const rewires: AgentTurn = ({ repo, input, exportCandidate }) => {
  if (!existsSync(join(repo, 'src/preload.ts'))) throw new Error('Workspace was not reused')
  if (!input.includes('orders:archived')) throw new Error('Correction did not reach the agent')
  writeFileSync(join(repo, 'src/preload.ts'), preload('orders:archived'))
  exportCandidate()
}
const neverRuns: AgentTurn = () => {
  throw new Error('This turn should have been cancelled')
}

function open(
  dataDir: string,
  remoteDir: string,
  baseline: CatalogGraph,
  server: FakeServer
): Promise<AgentBackend> {
  return createBackend({
    env: {},
    dataDir,
    authorizer: {
      async authorize(projectId) {
        if (projectId !== PROJECT) throw new Error(`Not authorized for ${projectId}`)
        return { projectId, repository: REPO, account: 'octo-dev' }
      }
    },
    model: scriptedModel(baseline),
    models: [MODEL],
    observedCatalog: async () => baseline,
    readSource: async () => null,
    codingProvider: () => new FakeProvider(server),
    exportScript,
    repos: new GitMirror({ root: join(dataDir, 'repos'), remoteUrl: () => `file://${remoteDir}` }),
    verifiers: [refundRetryVerifier(), catalogVerifier()]
  })
}

/** Lets the coding run's background create land, then refreshes the handoff. */
async function settle(app: AgentBackend, handoffId: string): Promise<HandoffRecord> {
  const h = (await app.workflow.getHandoff(PROJECT, handoffId))!
  await app.settleRun(h.runs.at(-1)!.run.runId)
  return app.workflow.refresh(PROJECT, handoffId)
}

// DIOGENES_LIVE_SMOKE=1 with GEMINI_API_KEY in the environment sends only the synthetic fixture.
it.skipIf(process.env.DIOGENES_LIVE_SMOKE !== '1')(
  'passes a live design proposal to the live coding agent and verifies its candidate locally',
  async () => {
    const apiKey = process.env.GEMINI_API_KEY?.trim()
    if (!apiKey) throw new Error('The live workflow check requires GEMINI_API_KEY.')
    const model = process.env.DIOGENES_LIVE_DESIGN_MODEL ?? DESIGN_MODELS[0]
    const { dir, base, baseline } = await remote()
    const dataDir = mkdtempSync(join(tmpdir(), 'dg-live-flow-'))
    const open = (): Promise<AgentBackend> =>
      createBackend({
        env: {},
        dataDir,
        authorizer: {
          async authorize(projectId) {
            if (projectId !== PROJECT) throw new Error(`Not authorized for ${projectId}`)
            return { projectId, repository: REPO, account: 'smoke' }
          }
        },
        model: geminiModelClient(),
        models: [model],
        observedCatalog: async () => baseline,
        readSource: async (_repo, sha, path) => git(dir, 'show', `${sha}:${path}`),
        codingProvider: () => createAntigravityProvider({ apiKey }),
        exportScript,
        repos: new GitMirror({ root: join(dataDir, 'repos'), remoteUrl: () => `file://${dir}` }),
        verifiers: [catalogVerifier()]
      })
    const app = await open()
    const thread = await app.threads.create(PROJECT, { kind: 'design', title: 'Live rewire' })
    await app.design.openProject(PROJECT)
    const { turn } = await app.design.startTurn({
      projectId: PROJECT,
      threadId: thread.id,
      model,
      graph: { repositoryId: REPO.id, commitSha: base, revision: 0 },
      selectedComponentId: CALLER,
      message: `Propose one rewire so the preload orders function calls orders:archived instead of orders:list. Inspect the source, current connection and both endpoint ports first. In the same atomic proposal, declare one dataContract for string[] and update the caller and archived endpoint ports to reference it, then rewire the existing calls edge with the same ID. Keep both handlers and all other connections unchanged.`
    })
    expect(turn.status, turn.error ?? turn.reply ?? 'Design agent returned no proposal').toBe(
      'awaiting-approval'
    )
    const { approval, approvalError } = await app.design.approve(PROJECT, turn.proposalId!, 0)
    expect(approval, approvalError).toBeTruthy()
    const packet = approval!.packet as CatalogApprovedChange
    expect(packet.connections.filter((c) => c.origin === 'required')).toEqual([
      expect.objectContaining({ expect: 'present', from: CALLER, to: ARCHIVED }),
      expect.objectContaining({ expect: 'absent', from: CALLER, to: LIST })
    ])
    // Port contracts the editor needs before connecting are metadata, not unobservable changes.
    expect(packet.unobservable).toEqual([])
    console.log(`Live ${model} proposal approved: ${JSON.stringify(packet.annotations)}`)
    let handoff = await app.workflow.startHandoff(PROJECT, approval!.approvalId)
    const wait = async (): Promise<void> => {
      await app.settleRun(handoff.runs.at(-1)!.run.runId)
      for (let i = 0; i < 36; i++) {
        handoff = await app.workflow.refresh(PROJECT, handoff.handoffId)
        if (handoff.stage !== 'coding' && handoff.stage !== 'verifying') return
        await new Promise((resolve) => setTimeout(resolve, 5000))
      }
      throw new Error('Timed out waiting for the live coding candidate.')
    }
    await wait()
    if (handoff.stage === 'correctable') {
      const state = await app.design.getProject(PROJECT)
      const intent = state.intents.find((i) => i.proposalId === turn.proposalId)!
      const correction = await app.design.startTurn({
        projectId: PROJECT,
        threadId: thread.id,
        model,
        graph: { repositoryId: REPO.id, commitSha: base, revision: state.draft!.revision },
        message: `Read local verification for intent ${intent.id} and request a correction for the failing obligations. Preserve the approved graph.`
      })
      expect(correction.handoff, correction.correctionError ?? correction.turn.error).toBeTruthy()
      handoff = correction.handoff!
      await wait()
    }
    const verdict = handoff.runs.at(-1)?.verdict
    expect(handoff.stage, JSON.stringify(handoff.decision ?? verdict?.obligations)).toBe('accepted')
    expect(verdict?.obligations.map((o) => [o.id, o.outcome])).toEqual([
      ['native-typecheck', 'pass'],
      ['catalog-conformance', 'pass']
    ])
    const verified = await app.workflow.verifiedPatch(PROJECT, handoff.handoffId)
    expect(verified).toMatchObject({ candidateId: verdict!.candidateId, baseCommit: base })
    const checkout = mkdtempSync(join(tmpdir(), 'dg-live-checkout-'))
    git(checkout, 'clone', '-q', dir, '.')
    execFileSync('git', ['-c', 'user.email=t@diogenes.invalid', '-c', 'user.name=t', 'am', '-q'], {
      cwd: checkout,
      input: verified.patch
    })
    expect(readFileSync(join(checkout, 'src/preload.ts'), 'utf8')).toContain('orders:archived')
    console.log(
      `Live run ${handoff.stage} after ${handoff.runs.length} attempt(s); verified patch ${verified.candidateId} (${verified.files.join(', ')}) applied to ${checkout}\n${verified.patch}`
    )
    await app.close()
    const reopened = await open()
    expect(await reopened.workflow.verdicts(PROJECT, handoff.handoffId)).toContainEqual(
      expect.objectContaining({ candidateId: verdict!.candidateId, overall: 'pass' })
    )
    const transcript = await reopened.threads.open(PROJECT, thread.id)
    expect(
      transcript.events.some(
        (event) => event.type === 'reference' && event.note?.includes('Local verification')
      )
    ).toBe(true)
    await reopened.close()
  },
  720_000
)

describe('catalog change through handoff, correction and local verification', () => {
  it("rewires a connection, rejects a candidate that misses it, and accepts the design agent's correction", async () => {
    const { dir: remoteDir, base, baseline } = await remote()
    expect(baseline.edges.map((e) => e.id)).toContain(EDGE)
    const dataDir = mkdtempSync(join(tmpdir(), 'dg-data-'))
    const server = new FakeServer([missesConnection, rewires, neverRuns])
    const app = await open(dataDir, remoteDir, baseline, server)

    // Design turn and approval against the picked, indexed commit.
    const thread = await app.threads.create(PROJECT, { kind: 'design', title: 'Orders' })
    await app.design.openProject(PROJECT)
    const { turn } = await app.design.startTurn({
      projectId: PROJECT,
      threadId: thread.id,
      model: MODEL,
      graph: { repositoryId: REPO.id, commitSha: base, revision: 0 },
      message: 'Make the preload orders call read archived orders.',
      selectedComponentId: CALLER
    })
    expect(turn.status).toBe('awaiting-approval')
    const approved = await app.design.approve(PROJECT, turn.proposalId!, 0)
    expect(approved.approvalError).toBeUndefined()
    const approval = approved.approval!
    const packet = approval.packet as CatalogApprovedChange
    expect(packet).toMatchObject({ kind: 'catalog', baseCommit: base, scope: ['src'] })
    expect(packet.connections.filter((c) => c.origin === 'required')).toEqual([
      expect.objectContaining({ expect: 'present', from: CALLER, to: ARCHIVED }),
      expect.objectContaining({ expect: 'absent', from: CALLER, to: LIST })
    ])
    expect(packet.preserved.length).toBeGreaterThan(1)
    expect(packet.unobservable).toEqual([])
    expect(packet.annotations).toHaveLength(3)
    expect(packet.sourceContext!.map((f) => f.path).sort()).toEqual([
      'src/main.ts',
      'src/preload.ts'
    ])
    // The base came from the remote by SHA; no clone was configured.
    expect(git(join(dataDir, 'repos', `${PROJECT}.git`), 'cat-file', '-t', base)).toBe('commit')

    // Starting twice returns the same handoff and sends one run.
    let h = await app.workflow.startHandoff(PROJECT, approval.approvalId)
    expect((await app.workflow.startHandoff(PROJECT, approval.approvalId)).handoffId).toBe(
      h.handoffId
    )
    const runId = h.runs[0].run.runId
    h = await settle(app, h.handoffId)
    expect(server.requests).toHaveLength(1)

    // Candidate 1 compiles but does not make the connection: rejected on local evidence.
    const first = h.runs[0]
    expect(first.candidate!.files).toEqual(['src/preload.ts'])
    const outcome = (id: string): ObligationVerdict | undefined =>
      first.verdict!.obligations.find((o) => o.id === id)
    expect(outcome('native-typecheck')).toMatchObject({ outcome: 'pass' })
    expect(outcome('catalog-conformance')).toMatchObject({ outcome: 'fail' })
    expect(outcome('catalog-conformance')!.diagnostic).toContain(ARCHIVED)
    expect(first.verdict).toMatchObject({ overall: 'fail', remoteClaim: 'completed' })
    expect(h.stage).toBe('correctable')

    const handoffId = h.handoffId
    // The design agent reads the verdict and requests a bounded correction in the same handoff.
    const draftNow = (await app.design.getProject(PROJECT)).draft!
    const fix = await app.design.startTurn({
      projectId: PROJECT,
      threadId: thread.id,
      model: MODEL,
      graph: { repositoryId: REPO.id, commitSha: base, revision: draftNow.revision },
      message: 'Local verification failed. Ask the coding agent to correct it.'
    })
    expect(fix.correctionError).toBeUndefined()
    expect(fix.turn.toolCalls.map((c) => [c.name, c.ok])).toEqual([
      ['read_verification', true],
      ['request_correction', true]
    ])
    h = fix.handoff!
    expect(h.handoffId).toBe(handoffId)
    expect(h.runs.map((r) => [r.origin, r.run.runId])).toEqual([
      ['start', runId],
      ['correction', runId]
    ])
    expect(h.runs[1].correction).toMatchObject({
      obligationIds: ['catalog-conformance'],
      previousCandidateId: first.candidate!.candidateId
    })
    await app.settleRun(runId)
    expect(server.requests[1]).toMatchObject({
      environmentId: 'env_1',
      previousInteractionId: expect.stringMatching(/^int_/)
    })
    expect(server.requests[1].sources).toBeUndefined()
    h = await settle(app, h.handoffId)
    const second = h.runs[1]
    expect(second.verdict!.obligations.map((o) => [o.id, o.outcome])).toEqual([
      ['native-typecheck', 'pass'],
      ['catalog-conformance', 'pass']
    ])
    expect(h.stage).toBe('accepted')
    expect(second.candidate!.candidateId).not.toBe(first.candidate!.candidateId)
    expect(
      git(
        join(dataDir, 'workflow', 'candidates', `${PROJECT}.git`),
        'rev-parse',
        `${second.candidate!.candidateId}^`
      )
    ).toBe(base)

    // A fresh backend on the same data recovers the handoff, verdicts and continuation refs.
    await app.close()
    const reopened = await open(dataDir, remoteDir, baseline, server)
    const verdicts = await reopened.workflow.verdicts(PROJECT, h.handoffId)
    expect(verdicts.map((v) => [v.candidateId, v.overall])).toEqual([
      [first.candidate!.candidateId, 'fail'],
      [second.candidate!.candidateId, 'pass']
    ])
    expect(verdicts.every((v) => v.approvalId === approval.approvalId)).toBe(true)

    // The exact verified commit comes back as a patch that applies to the developer's checkout.
    const verified = await reopened.workflow.verifiedPatch(PROJECT, h.handoffId)
    expect(verified).toMatchObject({
      candidateId: second.candidate!.candidateId,
      baseCommit: base,
      files: ['src/preload.ts']
    })
    const checkout = mkdtempSync(join(tmpdir(), 'dg-checkout-'))
    git(checkout, 'clone', '-q', remoteDir, '.')
    execFileSync('git', ['-c', 'user.email=t@diogenes.invalid', '-c', 'user.name=t', 'am', '-q'], {
      cwd: checkout,
      input: verified.patch
    })
    expect(git(checkout, 'rev-parse', 'HEAD^{tree}')).toBe(
      git(
        join(dataDir, 'workflow', 'candidates', `${PROJECT}.git`),
        'rev-parse',
        `${verified.candidateId}^{tree}`
      )
    )
    const handlers = readFileSync(join(checkout, 'src/main.ts'), 'utf8')
    expect(handlers).toContain("'orders:list'")
    expect(handlers).toContain("'orders:archived'")
    const run = await reopened.coding.status(PROJECT, runId)
    expect(run.environmentId).toBe('env_1')
    expect(run.turns.map((t) => t.interactionId)).toEqual([expect.any(String), expect.any(String)])

    // Steer after the restart, then cancel: the provider confirms the stop; nothing is resent.
    h = await reopened.workflow.steer(PROJECT, h.handoffId, 'Also log the call.')
    await reopened.settleRun(runId)
    h = await reopened.workflow.cancel(PROJECT, h.handoffId)
    expect(h.runs.at(-1)!.run.cancellation).toMatchObject({ outcome: 'confirmed' })
    expect(h.decision!.detail).toContain('confirmed')
    expect(server.cancels).toHaveLength(1)
    await expect(reopened.coding.retry(PROJECT, runId)).rejects.toThrow(/uncertain/)
    expect(server.requests).toHaveLength(3)
    await reopened.close()
  }, 300_000)
})
