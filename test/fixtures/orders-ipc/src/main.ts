import { ipcMain } from 'electron'

export function listOrders(): string[] {
  return ['open']
}

export function listArchivedOrders(): string[] {
  return ['archived']
}

ipcMain.handle('orders:list', () => listOrders())
ipcMain.handle('orders:archived', () => listArchivedOrders())
