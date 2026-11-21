import { mkdir, readdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import type { CodingRunView, StartCodingRun } from '../../shared/codingRun'

const RUN_ID = /^run_[0-9a-f]{32}$/

/** Durable run records. `CodingRunStore` (files) and `PgCodingRunStore` implement it. */
export interface CodingRunRepository {
  /** Saves the frozen input and the first run record. The input is never rewritten. */
  create(run: CodingRunView, input: StartCodingRun): Promise<void>
  save(run: CodingRunView): Promise<void>
  read(runId: string): Promise<CodingRunView | null>
  input(runId: string): Promise<StartCodingRun | null>
  list(): Promise<CodingRunView[]>
}

/**
 * On-disk layout under `<root>/<runId>/`:
 *   input.json   the frozen handoff and staged sources (written once, before any provider call)
 *   run.json     the current run record (rewritten atomically on every change)
 */
export class CodingRunStore implements CodingRunRepository {
  constructor(private readonly root: string) {}

  private dir(runId: string): string {
    if (!RUN_ID.test(runId)) throw new Error('Invalid coding run ID.')
    return join(this.root, runId)
  }

  async create(run: CodingRunView, input: StartCodingRun): Promise<void> {
    const dir = this.dir(run.runId)
    await mkdir(dir, { recursive: true })
    await atomicWrite(join(dir, 'input.json'), JSON.stringify(input))
    await atomicWrite(join(dir, 'run.json'), JSON.stringify(run))
  }

  async save(run: CodingRunView): Promise<void> {
    await atomicWrite(join(this.dir(run.runId), 'run.json'), JSON.stringify(run))
  }

  async read(runId: string): Promise<CodingRunView | null> {
    return readJson<CodingRunView>(join(this.dir(runId), 'run.json'))
  }

  async input(runId: string): Promise<StartCodingRun | null> {
    return readJson<StartCodingRun>(join(this.dir(runId), 'input.json'))
  }

  async list(): Promise<CodingRunView[]> {
    const ids = (await readdir(this.root).catch(() => [] as string[])).filter((id) =>
      RUN_ID.test(id)
    )
    const runs = await Promise.all(ids.map((id) => this.read(id)))
    return runs.filter((run): run is CodingRunView => run !== null)
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, path)
}
