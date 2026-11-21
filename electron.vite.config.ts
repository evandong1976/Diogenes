import { resolve } from 'path'
import { defineConfig, loadEnv } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command, mode }) => {
  if (command === 'serve' && !process.env.GEMINI_API_KEY) {
    const { GEMINI_API_KEY } = loadEnv(mode, process.cwd(), 'GEMINI_API_KEY')
    if (GEMINI_API_KEY) process.env.GEMINI_API_KEY = GEMINI_API_KEY
  }

  return {
    main: {},
    preload: {},
    renderer: {
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src')
        }
      },
      plugins: [react()]
    }
  }
})
