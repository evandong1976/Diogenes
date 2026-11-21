import { contextBridge, ipcRenderer } from 'electron'
import { geminiChannels, type DiogenesApi } from '../shared/gemini'

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
  proposeEdit: (graph, png) => ipcRenderer.invoke(geminiChannels.proposeEdit, graph, png)
}

// Electron prefixes main-process errors with "Error invoking remote method '<channel>': Error: ".
// Strip it so the UI can show GitHub's message as-is.
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args).catch((e: Error) => {
    throw new Error(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
  })

const api = {
  gemini,
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
