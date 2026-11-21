import { ipcMain } from 'electron'
import job from '../../../fixtures/background-job/source/job.ts?raw'
import worker from '../../../fixtures/background-job/source/worker.ts?raw'
import { geminiChannels } from '../../shared/gemini'
import { createGeminiService } from './service'

export function registerGeminiHandlers(): void {
  const service = createGeminiService([
    { path: 'job.ts', text: job },
    { path: 'worker.ts', text: worker }
  ])

  ipcMain.handle(geminiChannels.buildCurrentGraph, () => service.buildCurrentGraph())
  ipcMain.handle(geminiChannels.proposeEdit, (_event, graph: unknown, png: unknown) =>
    service.proposeEdit(graph, png)
  )
}
