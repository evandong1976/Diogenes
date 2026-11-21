import type { Job } from './job'

export async function processJob(job: Job): Promise<void> {
  job.status = 'running'

  try {
    await job.run()
    job.status = 'succeeded'
  } catch {
    job.status = 'failed'
  }
}
