/**
 * "Replace this Firebase-backed component with Supabase", headless, on a really indexed graph.
 *
 * The firebase-notes fixture is committed and indexed with the real pipeline. A scripted design
 * agent inspects the selected IPC operation and reads its source (turn 1), proposes a replacement
 * citing that evidence (turn 2), and revises it on request (turn 3). The revision is drawn on the
 * app canvas as a pending preview tied to its base revision; discarding it would remove the
 * preview, and approving the superseded first draft is refused. The approved revision is frozen
 * into a catalog packet whose Markdown brief carries the plan, the evidence and the scope.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DesignService } from '../../src/main/design/harness'
import { MemoryThreadHistory } from '../../src/main/design/history'
import type { ModelClient, ModelRequest, Part } from '../../src/main/design/model'
import { DesignStore } from '../../src/main/design/store'
import { runIndexJob } from '../../src/main/indexing/job'
import { ApprovalError, freezeApproval } from '../../src/main/workflow/approval'
import { codingBrief } from '../../src/main/workflow/brief'
import { planForApproval } from '../../src/main/workflow/catalogApproval'
import { focusedProposal, proposalOverlay } from '../../src/renderer/src/canvas/proposalOverlay'
import type { CatalogGraph } from '../../src/shared/catalog'
import type { TurnRecord } from '../../src/shared/design'
import type { AppFlow } from '../../src/shared/gemini'
import type { SoftwareGraph } from '../../src/shared/indexing'
import type { CatalogApprovedChange } from '../../src/shared/workflow'

const fixture = fileURLToPath(new URL('../fixtures/firebase-notes', import.meta.url))
const REPO = { id: 77, fullName: 'demo/notes' }
const MODEL = 'test-model'
// Real IDs from the indexer for this fixture.
const CALLER = 'generic:ts:src/preload.ts#notes0:'
const FIREBASE_OP = 'operation:electron-ipc:.:notes:firebase-list'
const MODULE = 'module:npm:.'
const CALL = `calls:${CALLER}->${FIREBASE_OP}`
const CONTAINS = `contains:${MODULE}->${FIREBASE_OP}`
// Designed in the proposal.
const SUPABASE_OP = 'operation:electron-ipc:.:notes:list'
const STORE = 'supabase-notes'
const CONTRACT = 'data-contract:notes'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

async function indexed(): Promise<{ dir: string; baseline: CatalogGraph }> {
  const dir = mkdtempSync(join(tmpdir(), 'dg-notes-'))
  cpSync(fixture, dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.email=t@diogenes.invalid', '-c', 'user.name=t', 'commit', '-qm', 'base')
  const sha = git(dir, 'rev-parse', 'HEAD')
  const work = mkdtempSync(join(tmpdir(), 'dg-notes-index-'))
  const archive = join(work, 'base.tar.gz')
  git(dir, 'archive', '--format=tar.gz', `--prefix=notes-${sha.slice(0, 7)}/`, '-o', archive, sha)
  const job = await runIndexJob({
    archivePath: archive,
    workDir: join(work, 'job'),
    outDir: join(work, 'out'),
    repository: REPO,
    commit: { sha, ref: 'main' }
  })
  const graph = JSON.parse(await readFile(job.graphPath, 'utf8')) as SoftwareGraph
  return { dir, baseline: graph.catalog! }
}

const call = (name: string, args: Record<string, unknown>): Part => ({
  functionCall: { id: `${name}-${Math.random().toString(36).slice(2, 6)}`, name, args },
  thoughtSignature: 'sig'
})

function replacement(
  baseline: CatalogGraph,
  evidenceIds: string[],
  files: string[]
): Record<string, unknown> {
  const caller = baseline.nodes.find((n) => n.id === CALLER)!
  return {
    summary: 'Serve notes from Supabase instead of Firebase, behind a new notes:list channel.',
    evidenceIds,
    plan: {
      behavior:
        'The renderer still calls api.notes(); the main process answers notes:list by selecting text from the Supabase notes table.',
      steps: [
        'Add src/supabase.ts with a client and listNotes() selecting text from the notes table.',
        'Handle notes:list in src/main.ts with the Supabase listNotes(); remove the notes:firebase-list handler.',
        'Point api.notes() in src/preload.ts at notes:list.',
        'Swap the firebase dependency for @supabase/supabase-js in package.json and delete src/firebase.ts.'
      ],
      preserved: ['api.notes() keeps returning Promise<string[]> of note text'],
      acceptance: ['api.notes() returns the same note texts for the same rows'],
      files
    },
    operations: [
      {
        type: 'create',
        node: {
          id: CONTRACT,
          kind: 'dataContract',
          name: 'Note list',
          resolution: 'declared',
          properties: { format: 'typescript' },
          ports: [],
          sources: []
        }
      },
      {
        type: 'update',
        node: {
          id: CALLER,
          ports: caller.ports.map((p) => ({ ...p, contractId: CONTRACT }))
        }
      },
      {
        type: 'create',
        node: {
          id: STORE,
          kind: 'resource',
          name: 'Supabase notes',
          properties: { resourceType: 'store', address: 'supabase:notes' },
          ports: [],
          sources: []
        }
      },
      {
        type: 'create',
        node: {
          id: SUPABASE_OP,
          kind: 'operation',
          name: 'notes:list',
          properties: { protocol: 'electron-ipc', address: 'notes:list' },
          ports: [{ id: 'in', direction: 'in', protocol: 'electron-ipc', contractId: CONTRACT }],
          sources: []
        }
      },
      {
        type: 'rewire',
        edge: {
          id: CALL,
          kind: 'calls',
          from: { nodeId: CALLER, portId: 'out:electron-ipc' },
          to: { nodeId: SUPABASE_OP, portId: 'in' }
        }
      },
      {
        type: 'connect',
        edge: {
          id: `depends_on:${SUPABASE_OP}->${STORE}`,
          kind: 'depends_on',
          from: { nodeId: SUPABASE_OP },
          to: { nodeId: STORE }
        }
      },
      { type: 'disconnect', edgeId: CONTAINS },
      { type: 'delete', nodeId: FIREBASE_OP },
      {
        type: 'connect',
        edge: {
          id: `contains:${MODULE}->${SUPABASE_OP}`,
          kind: 'contains',
          from: { nodeId: MODULE },
          to: { nodeId: SUPABASE_OP }
        }
      }
    ]
  }
}

/** The evidenceId of the first read_source in an earlier turn, as the harness reports it. */
const evidenceFrom = (requests: ModelRequest[]): string =>
  requests
    .flatMap((r) => r.contents.flatMap((c) => c.parts))
    .find((p) => p.functionResponse?.name === 'read_source')!.functionResponse!.response
    .evidenceId as string

/** Gemini's whiteboard for the fixture. */
const flow: AppFlow = {
  boxes: [
    { id: 'window', kind: 'screen', name: 'Notes window', summary: '', tables: [], paths: ['src/preload.ts'] },
    { id: 'ipc', kind: 'logic', name: 'Notes IPC', summary: '', tables: [], paths: ['src/main.ts'] },
    { id: 'firebase', kind: 'service', name: 'Firebase', summary: '', tables: [], paths: ['src/firebase.ts'] }
  ],
  links: [
    { id: 'window->ipc', from: 'window', to: 'ipc', label: 'lists notes' },
    { id: 'ipc->firebase', from: 'ipc', to: 'firebase', label: 'reads' }
  ]
}

describe('replacing an indexed Firebase-backed component', () => {
  it('plans across turns, previews the revision on the canvas, and freezes it into the brief', async () => {
    const { dir, baseline } = await indexed()
    const state = mkdtempSync(join(tmpdir(), 'dg-notes-design-'))
    try {
      expect(baseline.nodes.map((n) => n.id)).toEqual(
        expect.arrayContaining([CALLER, FIREBASE_OP, MODULE])
      )
      const requests: ModelRequest[] = []
      const steps: ((r: ModelRequest) => Part[])[] = [
        // Turn 1: look before planning.
        () => [
          call('inspect_component', { componentId: FIREBASE_OP }),
          call('follow_connections', { componentId: FIREBASE_OP, direction: 'both' }),
          call('read_source', { entityId: FIREBASE_OP })
        ],
        () => [{ text: 'notes:firebase-list is served from src/firebase.ts. Plan: …' }],
        // Turn 2: first proposal, citing turn 1's evidence; no extra files yet.
        () => [call('propose_graph_edit', replacement(baseline, [evidenceFrom(requests)], []))],
        () => [{ text: 'Proposed the replacement.' }],
        // Turn 3: the developer asks for the manifest and the new client file to be in scope.
        () => [
          call(
            'propose_graph_edit',
            replacement(baseline, [evidenceFrom(requests)], ['package.json', 'src/supabase.ts'])
          )
        ],
        () => [{ text: 'Revised: package.json and src/supabase.ts are in scope.' }]
      ]
      const model: ModelClient = {
        async generate(request) {
          requests.push(structuredClone({ ...request, signal: undefined }) as unknown as ModelRequest)
          return { parts: steps.shift()!(request), finishReason: 'STOP' }
        }
      }
      const service = new DesignService({
        store: new DesignStore(state),
        observedCatalog: async () => baseline,
        readSource: async (_repo, sha, path) => git(dir, 'show', `${sha}:${path}`),
        verification: { latest: async () => null },
        history: new MemoryThreadHistory(),
        model,
        models: [MODEL]
      })
      const project = String(REPO.id)
      await service.openProject(project, REPO.id)
      const graph = { repositoryId: REPO.id, commitSha: baseline.commit.sha, revision: 0 }
      const turn = (message: string): Promise<TurnRecord> =>
        service.startTurn({
          projectId: project,
          threadId: 'thr',
          model: MODEL,
          graph,
          message,
          selectedComponentId: FIREBASE_OP
        })

      expect((await turn('Replace this Firebase-backed component with Supabase.')).status).toBe(
        'completed'
      )
      const first = await turn('Go ahead and propose it.')
      expect(first.status).toBe('awaiting-approval')
      const revised = await turn('Also put package.json and the new client file in scope.')
      expect(revised.status).toBe('awaiting-approval')
      // The revision sees the pending plan it replaces.
      expect(JSON.stringify(requests.at(-1)!.contents)).toContain(`Pending proposal ${first.proposalId}`)

      const s = await service.getProject(project)
      const [v1, v2] = s.proposals
      expect(v1).toMatchObject({ status: 'stale', supersededBy: v2.id })
      expect(v2.evidence[0]).toMatchObject({ entityId: FIREBASE_OP, path: 'src/main.ts' })
      expect(v2.preview.components).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: SUPABASE_OP, change: 'added' }),
          expect.objectContaining({ id: STORE, change: 'added' }),
          expect.objectContaining({ id: FIREBASE_OP, change: 'removed' })
        ])
      )

      // The canvas draws the pending revision against draft r0.
      const focus = focusedProposal(s, s.draft, 'thr')
      expect(focus).toMatchObject({ status: 'pending', proposal: { id: v2.id } })
      const overlay = proposalOverlay(flow, focus as Extract<typeof focus, { base: CatalogGraph }>)
      expect(overlay).toMatchObject({ baseRevision: 0, resultRevision: 1, commitSha: baseline.commit.sha })
      expect(overlay.boxes.map((b) => [b.id, b.kind, b.change])).toEqual([
        [`pending:${STORE}`, 'data', 'added'],
        [`pending:${SUPABASE_OP}`, 'service', 'added']
      ])
      expect(overlay.boxMarks).toEqual({ window: 'updated', ipc: 'removed' })
      expect(overlay.linkMarks).toEqual({ 'window->ipc': 'removed' })
      expect(overlay.links).toEqual([
        { id: `added:${CALL}`, from: 'window', to: `pending:${SUPABASE_OP}`, label: 'rewire · calls', change: 'added' },
        {
          id: `added:depends_on:${SUPABASE_OP}->${STORE}`,
          from: `pending:${SUPABASE_OP}`,
          to: `pending:${STORE}`,
          label: 'depends on',
          change: 'added'
        }
      ])
      // Discarding reverts the canvas: nothing pending or approved is left to draw.
      const discarded = { ...s, proposals: s.proposals.map((p) => ({ ...p, status: 'rejected' as const })) }
      expect(focusedProposal(discarded, s.draft, 'thr')).toBeNull()

      // The superseded first draft cannot be approved; the revision can.
      expect(await service.approve(project, v1.id, 0)).toMatchObject({ ok: false, code: 'stale' })
      const approved = await service.approve(project, v2.id, 0)
      if (!approved.ok) throw new Error(approved.message)
      const after = await service.getProject(project)
      expect(focusedProposal(after, after.draft, 'thr')).toMatchObject({ status: 'approved' })

      // Freeze exactly what the backend hands the workflow, and read the coding brief.
      const request = {
        correlation: { projectId: project, threadId: 'thr', draftId: 'd', proposalId: v2.id },
        baseline: approved.intent.baseGraph!,
        patch: v2.patch,
        approvedBy: 'dev',
        plan: planForApproval(after.proposals[1], baseline.commit.sha)
      }
      const packet = freezeApproval(dir, request).packet as CatalogApprovedChange
      expect(packet.kind).toBe('catalog')
      expect(packet.scope).toEqual(['package.json', 'src'])
      expect(packet.plan?.files).toEqual(['package.json', 'src/supabase.ts'])
      expect(packet.connections).toEqual(
        expect.arrayContaining([expect.objectContaining({ expect: 'absent', from: CALLER, to: FIREBASE_OP })])
      )
      // The new operation is a designer-chosen ID: required, but unknown to the verifier.
      expect(packet.unobservable).toEqual(
        expect.arrayContaining(['add operation notes:list', `remove ${'notes:firebase-list'}`])
      )
      const brief = codingBrief(packet)
      expect(packet.targetComponentId).toBe(CALLER)
      for (const text of [
        '## Intended behavior',
        'Files the plan names: `package.json`, `src/supabase.ts`.',
        '1. Add src/supabase.ts',
        'api.notes() keeps returning Promise<string[]> of note text',
        '## Code evidence at',
        '`src/main.ts:',
        "ipcMain.handle('notes:firebase-list'",
        '## Acceptance checks from the plan (not verified by Diogenes)',
        '`git status`',
        'Do not connect to, migrate or seed any real database',
        'reported `unknown`, never passed'
      ])
        expect(brief).toContain(text)

      // A plan cannot widen the scope to a directory.
      const wide = { ...request, plan: { ...request.plan!, files: ['src'] } }
      expect(() => freezeApproval(dir, wide)).toThrow(ApprovalError)
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  }, 120_000)
})
