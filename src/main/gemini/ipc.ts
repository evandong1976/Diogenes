import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import job from '../../../fixtures/background-job/source/job.ts?raw'
import worker from '../../../fixtures/background-job/source/worker.ts?raw'
import verifyRetry from '../../../fixtures/background-job/verify-retry.mjs?raw'
import reporter from './verifier/report.mjs?raw'
import { isRetryOnceExample } from '../../shared/checks'
import {
  geminiChannels,
  type CaptureRect,
  type CurrentGraph,
  type ManagedAgentResult,
  type ProposedEdit,
  type RepoRef
} from '../../shared/gemini'
import { buildAppFlow, buildRepoGraph, filesForChange, proposeEdit, setCurrentFiles } from './repo'
import { createGeminiService } from './service'
import { loadAppFlow, saveAppFlow } from './flowStore'
import { runManagedChange, runManagedRetry } from './managed-agent'

const fixtureFiles = [
  { path: 'job.ts', text: job },
  { path: 'worker.ts', text: worker }
]

function toRepo(value: unknown): RepoRef {
  const repo = value as Partial<RepoRef> | null
  if (
    typeof repo?.fullName !== 'string' ||
    !/^[\w.-]+\/[\w.-]+$/.test(repo.fullName) ||
    typeof repo.branch !== 'string' ||
    !repo.branch
  ) {
    throw new Error('Expected a repository and branch.')
  }
  if (repo.id !== undefined && (!Number.isSafeInteger(repo.id) || repo.id <= 0)) {
    throw new Error('Expected a GitHub repository ID.')
  }
  return { id: repo.id, fullName: repo.fullName, branch: repo.branch }
}

function toRect(value: unknown): Electron.Rectangle {
  const r = value as Partial<CaptureRect> | null
  const fields = [r?.x, r?.y, r?.width, r?.height]
  if (!fields.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
    throw new Error('Expected a capture rectangle.')
  }
  const [x, y, width, height] = (fields as number[]).map(Math.round)
  if (!width || !height) throw new Error('Capture rectangle is empty.')
  return { x, y, width, height }
}

/**
 * Any approved change. The bundled example's retry-once edit keeps its fixed checks; every other
 * change is verified against checks derived from its edits. Graph and edits are fully validated
 * in runManagedChange once the files are known; this only routes the request.
 */
async function runChange(value: unknown): Promise<ManagedAgentResult> {
  const request = value as { graph?: unknown; edits?: unknown; repo?: unknown } | null
  const graph = request?.graph as CurrentGraph | undefined
  const edits = request?.edits
  if (!graph || !Array.isArray(graph.states) || !Array.isArray(graph.transitions)) {
    throw new Error('Expected the approved graph.')
  }
  if (!Array.isArray(edits)) throw new Error('Expected the approved edits.')
  if (request?.repo === undefined) {
    if (isRetryOnceExample(edits as ProposedEdit[])) {
      return runManagedRetry(fixtureFiles, verifyRetry, graph, edits[0])
    }
    return runManagedChange(graph, edits, fixtureFiles, reporter)
  }
  const repo = toRepo(request.repo)
  return runManagedChange(graph, edits, await filesForChange(repo, graph), reporter)
}

export function registerGeminiHandlers(): void {
  const fixture = createGeminiService(fixtureFiles)
  // The canvas starts on the fixture, so proposals are checked against its files until a repo loads.
  setCurrentFiles(fixtureFiles)

  ipcMain.handle(geminiChannels.buildCurrentGraph, async () => {
    const graph = await fixture.buildCurrentGraph()
    setCurrentFiles(fixtureFiles)
    return graph
  })
  ipcMain.handle(geminiChannels.useFixture, () => setCurrentFiles(fixtureFiles))
  ipcMain.handle(geminiChannels.buildRepoGraph, (_event, repo: unknown) =>
    buildRepoGraph(toRepo(repo))
  )
  const flowDir = join(app.getPath('userData'), 'app-flows')
  ipcMain.handle(geminiChannels.loadAppFlow, (_event, repoId: unknown) => {
    if (!Number.isSafeInteger(repoId) || (repoId as number) <= 0) return null
    return loadAppFlow(flowDir, repoId as number)
  })
  ipcMain.handle(geminiChannels.buildAppFlow, async (_event, value: unknown) => {
    const repo = toRepo(value)
    const flow = await buildAppFlow(repo)
    // Saving is a convenience: a failed write still returns the fresh map.
    if (repo.id) await saveAppFlow(flowDir, repo.id, flow).catch(() => {})
    return flow
  })
  ipcMain.handle(geminiChannels.proposeEdit, (_event, graph: unknown, png: unknown) =>
    proposeEdit(graph, png)
  )
  ipcMain.handle(geminiChannels.runManagedRetry, (_event, graph: unknown, proposal: unknown) =>
    runManagedRetry(fixtureFiles, verifyRetry, graph, proposal)
  )
  ipcMain.handle(geminiChannels.runManagedChange, (_event, request: unknown) => runChange(request))
  ipcMain.handle(geminiChannels.capture, async (event, rect: unknown) => {
    const image = await event.sender.capturePage(toRect(rect))
    return new Uint8Array(image.toPNG())
  })
}
