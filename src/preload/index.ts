import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { geminiChannels, type DiogenesApi } from '../shared/gemini'

// Custom APIs for renderer
const api: DiogenesApi = {
  gemini: {
    buildCurrentGraph: () => ipcRenderer.invoke(geminiChannels.buildCurrentGraph),
    proposeEdit: (graph, png) => ipcRenderer.invoke(geminiChannels.proposeEdit, graph, png)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
