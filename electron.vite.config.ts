import { resolve } from 'path'
import { defineConfig, loadEnv } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command, mode }) => {
  // `pnpm dev` reads GEMINI_API_KEY from .env when the shell doesn't set it.
  if (command === 'serve' && !process.env.GEMINI_API_KEY) {
    const { GEMINI_API_KEY } = loadEnv(mode, process.cwd(), 'GEMINI_API_KEY')
    if (GEMINI_API_KEY) process.env.GEMINI_API_KEY = GEMINI_API_KEY
  }

  return {
    main: {
      build: {
        rollupOptions: {
          input: {
            index: resolve('src/main/index.ts'),
            // Forked child process that runs repository indexing off the main thread.
            'indexer-worker': resolve('src/main/indexing/worker.ts')
          }
        }
      }
    },
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
