export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export interface Job {
  status: JobStatus
  run(): Promise<void>
}

export function enqueue(run: Job['run']): Job {
  return { status: 'queued', run }
}
