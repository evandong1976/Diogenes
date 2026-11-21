import { contextBridge, ipcRenderer } from 'electron'
import { geminiChannels, type DiogenesApi } from '../shared/gemini'

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

const api = {
  gemini,
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
