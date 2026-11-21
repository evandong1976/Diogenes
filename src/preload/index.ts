import { contextBridge, ipcRenderer } from 'electron'
import { catalogChannels, type CatalogApi } from '../shared/catalog'
import { geminiChannels, type DiogenesApi } from '../shared/gemini'
import { indexingChannels, type IndexStatus, type IndexingApi } from '../shared/indexing'

export type GithubUser = { login: string; name: string | null }
export type DeviceCode = { userCode: string; verificationUri: string }
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
  proposeEdit: (graph, png) => ipcRenderer.invoke(geminiChannels.proposeEdit, graph, png)
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
  indexing,
  github: {
    getUser: (): Promise<GithubUser | null> => ipcRenderer.invoke('github:getUser'),
    startLogin: (): Promise<DeviceCode> => ipcRenderer.invoke('github:startLogin'),
    finishLogin: (): Promise<GithubUser> => ipcRenderer.invoke('github:finishLogin'),
    logout: (): Promise<void> => ipcRenderer.invoke('github:logout'),
    listRepos: (): Promise<GithubRepo[]> => ipcRenderer.invoke('github:listRepos')
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
