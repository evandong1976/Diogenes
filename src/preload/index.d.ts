import { ElectronAPI } from '@electron-toolkit/preload'
import type { DiogenesApi } from '../shared/gemini'

declare global {
  interface Window {
    electron: ElectronAPI
    api: DiogenesApi
  }
}
