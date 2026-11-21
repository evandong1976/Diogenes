import { ipcMain } from 'electron'
import job from '../../../fixtures/background-job/source/job.ts?raw'
import worker from '../../../fixtures/background-job/source/worker.ts?raw'
import verifyRetry from '../../../fixtures/background-job/verify-retry.mjs?raw'
import { geminiChannels, type CaptureRect, type RepoRef } from '../../shared/gemini'
import { buildArchitecture, buildRepoGraph, proposeEdit, setCurrentFiles } from './repo'
import { createGeminiService } from './service'
import { runManagedRetry } from './managed-agent'

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
  return { fullName: repo.fullName, branch: repo.branch }
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
  ipcMain.handle(geminiChannels.buildArchitecture, (_event, repo: unknown) =>
    buildArchitecture(toRepo(repo))
  )
  ipcMain.handle(geminiChannels.proposeEdit, (_event, graph: unknown, png: unknown) =>
    proposeEdit(graph, png)
  )
  ipcMain.handle(geminiChannels.runManagedRetry, (_event, graph: unknown, proposal: unknown) =>
    runManagedRetry(fixtureFiles, verifyRetry, graph, proposal)
  )
  ipcMain.handle(geminiChannels.capture, async (event, rect: unknown) => {
    const image = await event.sender.capturePage(toRect(rect))
    return new Uint8Array(image.toPNG())
  })
}
