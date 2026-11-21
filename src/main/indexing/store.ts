import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import type { Coverage, SoftwareGraph } from '../../shared/indexing'

/** Written last into an artifact directory; its presence marks the artifact complete. */
export type ArtifactMeta = {
  repoId: number
  fullName: string
  sha: string
  ref: string
  analyzerConfigKey: string
  status: 'complete' | 'partial'
  completedAt: string
  coverage: Coverage
}

export type FailedAttempt = { sha?: string; error: string; at: string }

const SHA = /^[0-9a-f]{40}$/
const KEY = /^[0-9a-f]{16}$/

/**
 * On-disk layout under `<root>/<repoId>/`:
 *   <sha>-<configKey>/index.scip, graph.json, meta.json   published artifacts
 *   latest.json                                            pointer to the last published artifact
 *   last-failure.json                                      most recent failed attempt, if newer
 *   .staging-*                                             in-progress jobs (never read)
 */
export class GraphStore {
  constructor(private readonly root: string) {}

  private repoDir(repoId: number): string {
    if (!Number.isSafeInteger(repoId) || repoId <= 0) throw new Error('Invalid repository ID.')
    return join(this.root, String(repoId))
  }

  private artifactDir(repoId: number, sha: string, key: string): string {
    if (!SHA.test(sha) || !KEY.test(key)) throw new Error('Invalid artifact identity.')
    return join(this.repoDir(repoId), `${sha}-${key}`)
  }

  /** Removes staging directories left behind by a crash. */
  async sweepStaging(): Promise<void> {
    const repos = await readdir(this.root).catch(() => [] as string[])
    for (const r of repos) {
      const entries = await readdir(join(this.root, r)).catch(() => [] as string[])
      for (const e of entries) {
        if (e.startsWith('.staging-') || e.startsWith('.trash-')) {
          await rm(join(this.root, r, e), { recursive: true, force: true })
        }
      }
    }
  }

  /** A complete artifact for exactly this commit and analyzer configuration, if one exists. */
  async find(repoId: number, sha: string, key: string): Promise<ArtifactMeta | null> {
    const dir = this.artifactDir(repoId, sha, key)
    const meta = await readJson<ArtifactMeta>(join(dir, 'meta.json'))
    if (!meta) return null
    const ok = await Promise.all(
      ['graph.json', 'index.scip'].map((f) =>
        stat(join(dir, f)).then(
          (s) => s.isFile(),
          () => false
        )
      )
    )
    return ok.every(Boolean) ? meta : null
  }

  async createStaging(repoId: number): Promise<string> {
    const dir = this.repoDir(repoId)
    await mkdir(dir, { recursive: true })
    return mkdtemp(join(dir, '.staging-'))
  }

  /**
   * Atomically publishes a staged artifact: meta.json is written last, the directory is
   * renamed into place, then latest.json is swapped. Older artifacts for the repo are pruned.
   */
  async publish(staging: string, meta: ArtifactMeta): Promise<void> {
    const dest = this.artifactDir(meta.repoId, meta.sha, meta.analyzerConfigKey)
    await writeFile(join(staging, 'meta.json'), JSON.stringify(meta))
    const repoDir = this.repoDir(meta.repoId)
    const exists = await stat(dest).then(
      () => true,
      () => false
    )
    let trash: string | null = null
    if (exists) {
      trash = join(repoDir, `.trash-${Date.now()}`)
      await rename(dest, trash)
    }
    await rename(staging, dest)
    await this.setLatest(meta)
    if (trash) await rm(trash, { recursive: true, force: true })
    await rm(join(repoDir, 'last-failure.json'), { force: true })
    const keep = `${meta.sha}-${meta.analyzerConfigKey}`
    for (const e of await readdir(repoDir)) {
      if (/^[0-9a-f]{40}-[0-9a-f]{16}$/.test(e) && e !== keep) {
        await rm(join(repoDir, e), { recursive: true, force: true })
      }
    }
  }

  /** Points latest.json at an artifact that already exists (cache hit). */
  async setLatest(meta: ArtifactMeta): Promise<void> {
    await atomicWrite(join(this.repoDir(meta.repoId), 'latest.json'), JSON.stringify(meta))
  }

  async latest(repoId: number): Promise<ArtifactMeta | null> {
    const meta = await readJson<ArtifactMeta>(join(this.repoDir(repoId), 'latest.json'))
    if (!meta) return null
    return (await this.find(repoId, meta.sha, meta.analyzerConfigKey)) ? meta : null
  }

  async readGraph(repoId: number): Promise<SoftwareGraph | null> {
    const meta = await this.latest(repoId)
    if (!meta) return null
    return readJson<SoftwareGraph>(
      join(this.artifactDir(repoId, meta.sha, meta.analyzerConfigKey), 'graph.json')
    )
  }

  async recordFailure(repoId: number, f: FailedAttempt): Promise<void> {
    const dir = this.repoDir(repoId)
    await mkdir(dir, { recursive: true })
    await atomicWrite(join(dir, 'last-failure.json'), JSON.stringify(f))
  }

  async lastFailure(repoId: number): Promise<FailedAttempt | null> {
    return readJson<FailedAttempt>(join(this.repoDir(repoId), 'last-failure.json'))
  }

  /** Paths of the published artifact files, for diagnostics and tests. */
  async artifactPaths(repoId: number): Promise<{ graph: string; scip: string } | null> {
    const meta = await this.latest(repoId)
    if (!meta) return null
    const dir = this.artifactDir(repoId, meta.sha, meta.analyzerConfigKey)
    return { graph: join(dir, 'graph.json'), scip: join(dir, 'index.scip') }
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
