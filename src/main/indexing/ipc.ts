import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { catalogChannels, type CatalogPatch, type CatalogPatchResult } from '../../shared/catalog'
import { applyCatalogPatch } from '../catalog/editing'
import { indexingChannels } from '../../shared/indexing'
import { githubSourceHost } from './githubSource'
import { analyzerConfigKey } from './job'
import { IndexingService, forkRunner } from './service'
import { DEFAULT_LIMITS } from './snapshot'
import { GraphStore } from './store'

function repoId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Expected a GitHub repository ID.')
  }
  return value
}

export function registerIndexingIpc(): void {
  const store = new GraphStore(join(app.getPath('userData'), 'indexes'))
  void store.sweepStaging()
  const service = new IndexingService({
    host: githubSourceHost,
    store,
    // Built next to index.js by electron-vite (see electron.vite.config.ts).
    runner: forkRunner(join(__dirname, 'indexer-worker.js')),
    tmpRoot: app.getPath('temp'),
    configKey: analyzerConfigKey(DEFAULT_LIMITS),
    limits: DEFAULT_LIMITS,
    emit: (status) => {
      for (const w of BrowserWindow.getAllWindows())
        w.webContents.send(indexingChannels.status, status)
    }
  })

  ipcMain.handle(indexingChannels.start, (_e, id: unknown) => service.start(repoId(id)))
  ipcMain.handle(indexingChannels.retry, (_e, id: unknown) =>
    service.start(repoId(id), { force: true })
  )
  ipcMain.handle(indexingChannels.getStatus, (_e, id: unknown) => service.getStatus(repoId(id)))
  ipcMain.handle(indexingChannels.getGraph, (_e, id: unknown) => service.getGraph(repoId(id)))
  ipcMain.handle(
    catalogChannels.preview,
    async (_e, value: unknown): Promise<CatalogPatchResult> => {
      if (!value || typeof value !== 'object') throw new Error('Expected a catalog patch.')
      const patch = value as CatalogPatch
      if (
        typeof patch.commitSha !== 'string' ||
        !Number.isSafeInteger(patch.baseRevision) ||
        !Array.isArray(patch.operations)
      ) {
        throw new Error('Expected a versioned catalog patch.')
      }
      const graph = (await service.getGraph(repoId(patch.repositoryId)))?.catalog
      if (!graph) {
        return {
          ok: false,
          issue: { code: 'missing', message: 'Index the repository before editing.' }
        }
      }
      return applyCatalogPatch(graph, patch)
    }
  )
}
