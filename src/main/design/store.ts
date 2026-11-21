import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import type { ProjectState } from '../../shared/design'

const PROJECT_ID = /^[A-Za-z0-9_-]{1,80}$/

export function checkProjectId(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_ID.test(value)) {
    throw new Error('Expected a project ID of letters, digits, "-" or "_".')
  }
  return value
}

/** Project design state. `update` runs one change at a time per project and persists it atomically. */
export interface DesignStateStore {
  read(projectId: string): Promise<ProjectState>
  update<T>(projectId: string, change: (state: ProjectState) => T): Promise<T>
}

export const emptyProjectState = (projectId: string): ProjectState => ({
  projectId,
  draft: null,
  proposals: [],
  intents: [],
  corrections: [],
  turns: []
})

/**
 * One JSON document per project under `root`. Every change goes through `update`, which runs
 * changes for a project one at a time and writes atomically, so a crash leaves the previous state.
 * Use one instance per directory: it caches state and is the only writer.
 */
export class DesignStore implements DesignStateStore {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly cache = new Map<string, ProjectState>()

  constructor(private readonly root: string) {}

  async read(projectId: string): Promise<ProjectState> {
    await this.queues.get(projectId)
    return structuredClone(await this.load(checkProjectId(projectId)))
  }

  /** Applies `change` to a copy of the state and persists it if it does not throw. */
  update<T>(projectId: string, change: (state: ProjectState) => T): Promise<T> {
    const id = checkProjectId(projectId)
    const run = (this.queues.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const state = structuredClone(await this.load(id))
        const result = change(state)
        await this.save(id, state)
        this.cache.set(id, state)
        return result
      })
    this.queues.set(id, run)
    return run
  }

  private async load(id: string): Promise<ProjectState> {
    const hit = this.cache.get(id)
    if (hit) return hit
    let state: ProjectState
    try {
      state = JSON.parse(await readFile(this.path(id), 'utf8')) as ProjectState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      state = emptyProjectState(id)
    }
    this.cache.set(id, state)
    return state
  }

  private async save(id: string, state: ProjectState): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const tmp = `${this.path(id)}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(state))
    await rename(tmp, this.path(id))
  }

  private path(id: string): string {
    return join(this.root, `${id}.json`)
  }
}
