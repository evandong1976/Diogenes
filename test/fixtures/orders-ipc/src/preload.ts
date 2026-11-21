import { ipcRenderer } from 'electron'

export const api = {
  orders: (): Promise<string[]> => ipcRenderer.invoke('orders:list')
}
