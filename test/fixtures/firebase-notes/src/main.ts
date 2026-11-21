import { ipcMain } from 'electron'
import { listNotes } from './firebase'

ipcMain.handle('notes:firebase-list', () => listNotes())
