// Child-process entry point. Forked by the main process so extraction, scip-typescript,
// and the AST pass never block Electron's main thread. Receives no GitHub credentials.
import type { IndexStage } from '../../shared/indexing'
import { runIndexJob, type JobInput, type JobResult } from './job'

export type WorkerMessage =
  | { type: 'stage'; stage: IndexStage }
  | { type: 'done'; result: JobResult }
  | { type: 'error'; message: string }

const send = (m: WorkerMessage): Promise<void> =>
  new Promise((resolve) => {
    if (!process.send) return resolve()
    process.send(m, undefined, {}, () => resolve())
  })

process.once('message', (input: JobInput) => {
  runIndexJob(input, (stage) => void send({ type: 'stage', stage })).then(
    async (result) => {
      await send({ type: 'done', result })
      process.exit(0)
    },
    async (e: Error) => {
      await send({ type: 'error', message: e?.message ?? String(e) })
      process.exit(1)
    }
  )
})
