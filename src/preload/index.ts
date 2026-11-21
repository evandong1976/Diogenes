import { contextBridge, ipcRenderer } from 'electron'
import { catalogChannels, type CatalogApi } from '../shared/catalog'
import { geminiChannels, type DiogenesApi } from '../shared/gemini'
import { indexingChannels, type IndexStatus, type IndexingApi } from '../shared/indexing'

export type GithubUser = { login: string; name: string | null }
export type DeviceCode = { userCode: string; verificationUri: string }
export type NewRepo = { name: string; description: string; private: boolean }
export type GithubRepo = {
  id: number
  fullName: string
  private: boolean
  description: string | null
  defaultBranch: string
  updatedAt: string
}

const gemini: DiogenesApi['gemini'] = {
  buildCurrentGraph: () => ipcRenderer.invoke(geminiChannels.buildCurrentGraph),
  useFixture: () => ipcRenderer.invoke(geminiChannels.useFixture),
  buildRepoGraph: (repo) => ipcRenderer.invoke(geminiChannels.buildRepoGraph, repo),
  buildArchitecture: (repo) => ipcRenderer.invoke(geminiChannels.buildArchitecture, repo),
  proposeEdit: (graph, png) => ipcRenderer.invoke(geminiChannels.proposeEdit, graph, png),
  runManagedRetry: (graph, proposal) =>
    ipcRenderer.invoke(geminiChannels.runManagedRetry, graph, proposal)
}

// Electron prefixes main-process errors with "Error invoking remote method '<channel>': Error: ".
// Strip it so the UI can show GitHub's message as-is.
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args).catch((e: Error) => {
    throw new Error(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
  })

const canvas: DiogenesApi['canvas'] = {
  capture: (rect) => ipcRenderer.invoke(geminiChannels.capture, rect)
}

const indexing: IndexingApi = {
  start: (repoId) => ipcRenderer.invoke(indexingChannels.start, repoId),
  retry: (repoId) => ipcRenderer.invoke(indexingChannels.retry, repoId),
  getStatus: (repoId) => ipcRenderer.invoke(indexingChannels.getStatus, repoId),
  getGraph: (repoId) => ipcRenderer.invoke(indexingChannels.getGraph, repoId),
  onStatus: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, status: IndexStatus): void => listener(status)
    ipcRenderer.on(indexingChannels.status, handler)
    return () => ipcRenderer.removeListener(indexingChannels.status, handler)
  }
}

const catalog: CatalogApi = {
  preview: (patch) => ipcRenderer.invoke(catalogChannels.preview, patch)
}

const api = {
  catalog,
  gemini,
  canvas,
  indexing,
  github: {
    getUser: (): Promise<GithubUser | null> => invoke('github:getUser'),
    startLogin: (): Promise<DeviceCode> => invoke('github:startLogin'),
    finishLogin: (): Promise<GithubUser> => invoke('github:finishLogin'),
    logout: (): Promise<void> => invoke('github:logout'),
    listRepos: (): Promise<GithubRepo[]> => invoke('github:listRepos'),
    createRepo: (repo: NewRepo): Promise<GithubRepo> => invoke('github:createRepo', repo)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
