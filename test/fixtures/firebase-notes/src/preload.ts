import { ipcRenderer } from 'electron'

export const api = {
  notes: (): Promise<string[]> => ipcRenderer.invoke('notes:firebase-list')
}
