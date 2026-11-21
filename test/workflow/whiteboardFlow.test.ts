/**
 * An accepted whiteboard edit built in a real repository, headless, with only provider calls faked.
 *
 * The design agent (scripted) answers a note on the whiteboard with a whiteboard edit. Accepting it
 * freezes the edit with the source of the boxes it touches (fetched from the scratch remote by the
 * exact SHA), starts a managed run whose brief and workspace carry that change, and the candidate
 * the agent exports is type checked locally before the handoff is accepted.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createBackend, type AgentBackend } from '../../src/main/backend/backend'
import { GitMirror } from '../../src/main/backend/repos'
import type { ModelClient, Part } from '../../src/main/design/model'
import { catalogVerifier, whiteboardVerifier } from '../../src/main/workflow/verifiers'
import type { CatalogGraph } from '../../src/shared/catalog'
import type { WhiteboardSnapshot } from '../../src/shared/design'
import type { HandoffRecord, WhiteboardApprovedChange } from '../../src/shared/workflow'
import { FakeProvider, FakeServer, type AgentTurn } from '../coding/fakeProvider'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const fixture = join(repoRoot, 'test/fixtures/orders-ipc')
const exportScript = readFileSync(join(repoRoot, 'src/main/coding/export-candidate.mjs'), 'utf8')
const PROJECT = '4343'
const REPO = { id: 4343, fullName: 'octo/orders' }
const MODEL = 'test-model'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function remote(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dg-remote-'))
  cpSync(fixture, dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.email=t@diogenes.invalid', '-c', 'user.name=t', 'commit', '-qm', 'base')
  return { dir, base: git(dir, 'rev-parse', 'HEAD') }
}

/** A catalog is still needed to open the design draft; the whiteboard path never edits it. */
const emptyCatalog = (base: string): CatalogGraph =>
  ({
    schemaVersion: 1,
    repository: REPO,
    commit: { sha: base, ref: 'main' },
    revision: 0,
    nodes: [],
    edges: []
  }) as unknown as CatalogGraph

const whiteboard: WhiteboardSnapshot = {
  boxes: [
    {
      id: 'orders-view',
      kind: 'screen',
      name: 'Orders view',
      summary: 'Lists orders.',
      tables: [],
      paths: ['src/preload.ts']
    },
    {
      id: 'orders-api',
      kind: 'service',
      name: 'Orders IPC',
      summary: 'Answers orders:list.',
      tables: [],
      paths: ['src/main.ts']
    }
  ],
  links: [{ id: 'orders-view->orders-api', from: 'orders-view', to: 'orders-api', label: 'list' }],
  notes: [{ text: 'Show archived orders instead', target: 'orders-view' }]
}

const EDIT = {
  summary: 'The orders view reads archived orders.',
  updateBoxes: [{ id: 'orders-view', summary: 'Lists archived orders.' }],
  addBoxes: [{ id: 'archive', kind: 'data', name: 'Order archive', tables: ['archived_orders'] }],
  addLinks: [{ from: 'orders-view', to: 'archive', label: 'reads' }]
}

function scriptedModel(): ModelClient {
  const steps: Part[][] = [
    [{ functionCall: { id: 'wb-1', name: 'propose_whiteboard_edit', args: EDIT } }],
    [{ text: 'Proposed reading archived orders.' }]
  ]
  return {
    async generate() {
      const parts = steps.shift()
      if (!parts) throw new Error('Model script exhausted.')
      return { parts, finishReason: 'STOP' }
    }
  }
}

/** Reads the brief it was given, then makes a change that compiles. */
const implementsIt: AgentTurn = ({ repo, input, exportCandidate }) => {
  for (const expected of [
    'The orders view reads archived orders.',
    'Developer note on "Orders view": Show archived orders instead',
    'Add data "Order archive" with archived_orders',
    'Accepted whiteboard edit'
  ])
    if (!input.includes(expected)) throw new Error(`Brief is missing: ${expected}`)
  writeFileSync(
    join(repo, 'src/preload.ts'),
    [
      "import { ipcRenderer } from 'electron'",
      '',
      'export const api = {',
      "  orders: (): Promise<string[]> => ipcRenderer.invoke('orders:archived')",
      '}',
      ''
    ].join('\n')
  )
  exportCandidate()
}

function open(
  dataDir: string,
  remoteDir: string,
  base: string,
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
    model: scriptedModel(),
    models: [MODEL],
    observedCatalog: async () => emptyCatalog(base),
    readSource: async () => null,
    codingProvider: () => new FakeProvider(server),
    exportScript,
    repos: new GitMirror({ root: join(dataDir, 'repos'), remoteUrl: () => `file://${remoteDir}` }),
    verifiers: [catalogVerifier(), whiteboardVerifier()]
  })
}

async function settle(app: AgentBackend, handoffId: string): Promise<HandoffRecord> {
  const h = (await app.workflow.getHandoff(PROJECT, handoffId))!
  await app.settleRun(h.runs.at(-1)!.run.runId)
  return app.workflow.refresh(PROJECT, handoffId)
}

describe('accepted whiteboard edit through a coding run', () => {
  it('sends the edit, notes and touched source, and accepts a candidate that compiles', async () => {
    const { dir: remoteDir, base } = remote()
    const server = new FakeServer([implementsIt])
    const app = await open(mkdtempSync(join(tmpdir(), 'dg-data-')), remoteDir, base, server)

    const thread = await app.threads.create(PROJECT, { kind: 'design', title: 'Orders' })
    await app.design.openProject(PROJECT)
    const { turn } = await app.design.startTurn({
      projectId: PROJECT,
      threadId: thread.id,
      model: MODEL,
      graph: { repositoryId: REPO.id, commitSha: base, revision: 0 },
      message: '- On "Orders view": Show archived orders instead',
      whiteboard
    })
    expect(turn.status).toBe('completed')
    expect(turn.whiteboardEdit?.summary).toBe(EDIT.summary)

    const { approval, handoff } = await app.workflow.buildWhiteboard(PROJECT, turn.id)
    const packet = approval.packet as WhiteboardApprovedChange
    expect(packet).toMatchObject({
      kind: 'whiteboard',
      baseCommit: base,
      targetComponentId: 'orders-view',
      // The touched box's folder, plus the manifest so a dependency can be added.
      scope: ['package.json', 'src']
    })
    expect(packet.requiredChanges).toEqual([
      'The orders view reads archived orders.',
      'Add data "Order archive" with archived_orders',
      'Change "Orders view" (code: src/preload.ts): it now: Lists archived orders.',
      '"Orders view" uses "Order archive" (reads)',
      'Developer note on "Orders view": Show archived orders instead'
    ])
    expect(packet.sourceContext!.map((f) => f.path).sort()).toEqual([
      'package.json',
      'src/main.ts',
      'src/preload.ts'
    ])
    expect(packet.obligations.map((o) => o.id)).toEqual(['native-typecheck'])
    // Accepting twice is the same approval and the same open handoff.
    const again = await app.workflow.buildWhiteboard(PROJECT, turn.id)
    expect(again.approval.approvalId).toBe(approval.approvalId)
    expect(again.handoff.handoffId).toBe(handoff.handoffId)

    // The run was seeded with the frozen source and told what it may edit.
    const done = await settle(app, handoff.handoffId)
    expect(server.requests).toHaveLength(1)
    const run = done.runs[0]
    expect(run.candidate!.files).toEqual(['src/preload.ts'])
    expect(run.verdict).toMatchObject({ overall: 'pass', verifier: 'diogenes-whiteboard-v1' })
    expect(run.verdict!.obligations).toEqual([
      expect.objectContaining({ id: 'native-typecheck', outcome: 'pass' })
    ])
    expect(done.stage).toBe('accepted')
  }, 120_000)

  it('refuses a turn that proposed nothing', async () => {
    const { dir: remoteDir, base } = remote()
    const app = await open(
      mkdtempSync(join(tmpdir(), 'dg-data-')),
      remoteDir,
      base,
      new FakeServer([])
    )
    await expect(app.workflow.buildWhiteboard(PROJECT, 'turn-nope')).rejects.toThrow(
      /proposed no whiteboard change/
    )
  })
})
