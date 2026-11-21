/**
 * A real repository edit through the integrated backend, headless, with only provider calls faked.
 *
 * A small Electron repository is committed to a scratch "remote" and indexed with the real
 * pipeline. The design agent (scripted) proposes rewiring the preload's `orders` call from
 * `orders:list` to `orders:archived`; approval fetches the exact base commit by SHA from the remote
 * (no configured clone) and freezes a catalog packet. The managed agent (the Antigravity fake)
 * first returns a candidate that compiles but keeps the old connection; the developer steers the
 * same workspace and the follow-up turn fixes it. Each candidate is materialized, type checked and
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
import type { ModelClient, Part } from '../../src/main/design/model'
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
              ...[CALLER, ARCHIVED].map((id) => {
                const node = baseline.nodes.find((n) => n.id === id)!
                return {
                  type: 'update',
                  node: { ...node, ports: node.ports.map((p) => ({ ...p, contractId: CONTRACT })) }
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
    [{ text: 'Proposed rewiring orders to orders:archived.' }]
  ]
  return {
    async generate() {
      const parts = steps.shift()
      if (!parts) throw new Error('Model script exhausted.')
      return { parts, finishReason: 'STOP' }
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
  if (!input.includes('orders:archived')) throw new Error('Steer did not reach the agent')
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

describe('catalog change through handoff, steer and local verification', () => {
  it('rewires a connection, rejects a candidate that misses it, and accepts the steered fix', async () => {
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

    // Steer the same workspace: a chained turn with the same environment and no restaging.
    h = await app.workflow.steer(
      PROJECT,
      h.handoffId,
      'Call orders:archived instead of orders:list.'
    )
    expect(h.runs.map((r) => [r.origin, r.run.runId])).toEqual([
      ['start', runId],
      ['steer', runId]
    ])
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
