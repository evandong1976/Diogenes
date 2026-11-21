import { contextBridge, ipcRenderer } from 'electron'
import { catalogChannels, type CatalogApi } from '../shared/catalog'
import { geminiChannels, type DiogenesApi } from '../shared/gemini'
import { indexingChannels, type IndexStatus, type IndexingApi } from '../shared/indexing'
import { backendChannels, type BackendApi } from '../shared/backend'

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
  buildAppFlow: (repo) => ipcRenderer.invoke(geminiChannels.buildAppFlow, repo),
  loadAppFlow: (repoId) => ipcRenderer.invoke(geminiChannels.loadAppFlow, repoId),
  proposeEdit: (graph, png) => ipcRenderer.invoke(geminiChannels.proposeEdit, graph, png),
  runManagedRetry: (graph, proposal) =>
    ipcRenderer.invoke(geminiChannels.runManagedRetry, graph, proposal),
  runManagedChange: (request) => ipcRenderer.invoke(geminiChannels.runManagedChange, request)
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

// Project-scoped agent backend. Every call names the project; the main process checks GitHub
// access to it and resolves every other ID inside it.
const b = backendChannels
const backend: BackendApi = {
  status: () => invoke(b.status),
  threads: {
    create: (projectId, input) => invoke(b.threadsCreate, projectId, input),
    list: (projectId, filter) => invoke(b.threadsList, projectId, filter),
    open: (projectId, threadId) => invoke(b.threadsOpen, projectId, threadId),
    eventsSince: (projectId, threadId, afterSeq) =>
      invoke(b.threadsEventsSince, projectId, threadId, afterSeq)
  },
  design: {
    openProject: (projectId) => invoke(b.designOpenProject, projectId),
    getProject: (projectId) => invoke(b.designGetProject, projectId),
    startTurn: (input) => invoke(b.designStartTurn, input),
    cancelTurn: (projectId, turnId) => invoke(b.designCancelTurn, projectId, turnId),
    reject: (projectId, proposalId, reason) =>
      invoke(b.designReject, projectId, proposalId, reason),
    approve: (projectId, proposalId, expectedRevision) =>
      invoke(b.designApprove, projectId, proposalId, expectedRevision)
  },
  workflow: {
    preview: (request) => invoke(b.workflowPreview, request),
    getProject: (projectId) => invoke(b.workflowGetProject, projectId),
    startHandoff: (projectId, approvalId) => invoke(b.workflowStartHandoff, projectId, approvalId),
    getHandoff: (projectId, handoffId) => invoke(b.workflowGetHandoff, projectId, handoffId),
    refresh: (projectId, handoffId) => invoke(b.workflowRefresh, projectId, handoffId),
    steer: (projectId, handoffId, message) =>
      invoke(b.workflowSteer, projectId, handoffId, message),
    cancel: (projectId, handoffId) => invoke(b.workflowCancel, projectId, handoffId),
    requestCorrection: (projectId, handoffId, request) =>
      invoke(b.workflowRequestCorrection, projectId, handoffId, request),
    resolveDecision: (projectId, handoffId, option) =>
      invoke(b.workflowResolveDecision, projectId, handoffId, option),
    verdicts: (projectId, handoffId) => invoke(b.workflowVerdicts, projectId, handoffId),
    verifiedPatch: (projectId, handoffId) => invoke(b.workflowVerifiedPatch, projectId, handoffId)
  },
  coding: {
    list: (projectId) => invoke(b.codingList, projectId),
    status: (projectId, runId) => invoke(b.codingStatus, projectId, runId),
    retry: (projectId, runId) => invoke(b.codingRetry, projectId, runId),
    cancel: (projectId, runId) => invoke(b.codingCancel, projectId, runId)
  }
}

const api = {
  catalog,
  backend,
  workflow: backend.workflow,
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
