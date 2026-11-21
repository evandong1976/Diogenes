import { fork } from 'child_process'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { join } from 'path'
import type { IndexStage, IndexStatus, IndexedSnapshot, SoftwareGraph } from '../../shared/indexing'
import type { JobInput, JobResult } from './job'
import type { SnapshotLimits } from './snapshot'
import type { ArtifactMeta, GraphStore } from './store'
import type { WorkerMessage } from './worker'

export type SourceRepo = { id: number; fullName: string; defaultBranch: string }

/** Everything the service needs from GitHub. Implemented over the signed-in session in production. */
export interface SourceHost {
  /** Changes whenever the signed-in account changes. */
  generation(): number
  onSessionChange(listener: () => void): () => void
  /** The repository as seen by the current session, or null if it cannot read it. */
  getRepo(id: number, signal?: AbortSignal): Promise<SourceRepo | null>
  resolveCommit(repo: SourceRepo, signal?: AbortSignal): Promise<{ sha: string; ref: string }>
  downloadArchive(
    repo: SourceRepo,
    sha: string,
    dest: string,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<void>
}

export type JobRunner = (
  input: JobInput,
  onStage: (stage: IndexStage) => void,
  signal: AbortSignal
) => Promise<JobResult>

export class RepoAccessError extends Error {
  constructor(id: number) {
    super(`Repository ${id} is not accessible with the current GitHub session.`)
  }
}

type Running = { controller: AbortController; generation: number; promise: Promise<void> }

const VALIDATION_TTL_MS = 60_000

export class IndexingService {
  private readonly statuses = new Map<number, IndexStatus>()
  private readonly running = new Map<number, Running>()
  private validated = new Map<number, { generation: number; repo: SourceRepo; at: number }>()

  constructor(
    private readonly opts: {
      host: SourceHost
      store: GraphStore
      runner: JobRunner
      tmpRoot: string
      configKey: string
      limits: SnapshotLimits
      emit?: (status: IndexStatus) => void
    }
  ) {
    opts.host.onSessionChange(() => {
      // Another account may not see these repos: forget validations and stop in-flight work.
      this.validated = new Map()
      for (const r of this.running.values())
        r.controller.abort(new Error('GitHub account changed.'))
      this.statuses.clear()
    })
  }

  /** Confirms the current session can read the repo. Required before any source or cached graph. */
  async validate(id: number): Promise<SourceRepo> {
    const generation = this.opts.host.generation()
    const hit = this.validated.get(id)
    if (hit && hit.generation === generation && Date.now() - hit.at < VALIDATION_TTL_MS) {
      return hit.repo
    }
    const repo = await this.opts.host.getRepo(id)
    if (!repo) throw new RepoAccessError(id)
    if (this.opts.host.generation() === generation) {
      this.validated.set(id, { generation, repo, at: Date.now() })
    }
    return repo
  }

  async getStatus(id: number): Promise<IndexStatus> {
    const repo = await this.validate(id)
    return this.statuses.get(id) ?? (await this.statusFromDisk(repo))
  }

  async getGraph(id: number): Promise<SoftwareGraph | null> {
    await this.validate(id)
    return this.opts.store.readGraph(id)
  }

  /** Starts indexing the default branch. `force` re-indexes even when a cached graph matches. */
  async start(id: number, opts: { force?: boolean } = {}): Promise<IndexStatus> {
    const repo = await this.validate(id)
    const existing = this.running.get(id)
    if (existing) return this.statuses.get(id)!
    const lastIndexed = (await this.statusFromDisk(repo)).lastIndexed
    const controller = new AbortController()
    const generation = this.opts.host.generation()
    this.set({
      repoId: id,
      fullName: repo.fullName,
      state: 'running',
      stage: 'resolving',
      lastIndexed
    })
    const promise = this.run(repo, !!opts.force, controller.signal, generation).finally(() => {
      this.running.delete(id)
    })
    this.running.set(id, { controller, generation, promise })
    return this.statuses.get(id)!
  }

  /** Resolves when any running job for the repo finishes. For tests and shutdown. */
  async idle(id: number): Promise<void> {
    await this.running.get(id)?.promise
  }

  private async run(
    repo: SourceRepo,
    force: boolean,
    signal: AbortSignal,
    generation: number
  ): Promise<void> {
    const { store, host, configKey } = this.opts
    const base = (): IndexStatus =>
      this.statuses.get(repo.id) ?? {
        repoId: repo.id,
        fullName: repo.fullName,
        state: 'running',
        lastIndexed: null
      }
    // Status writes from a job whose account was signed out are dropped.
    const update = (s: IndexStatus): void => {
      if (!signal.aborted && host.generation() === generation) this.set(s)
    }
    const stage = (s: IndexStage): void => update({ ...base(), stage: s })
    let workDir: string | null = null
    let staging: string | null = null
    let sha: string | undefined
    try {
      const commit = await host.resolveCommit(repo, signal)
      sha = commit.sha
      update({ ...base(), attemptSha: sha })

      if (!force) {
        const cached = await store.find(repo.id, sha, configKey)
        if (cached) {
          await store.setLatest(cached)
          update(finished(repo, cached, true))
          return
        }
      }

      workDir = await mkdtemp(join(this.opts.tmpRoot, 'diogenes-index-'))
      const archivePath = join(workDir, 'source.tar.gz')
      stage('downloading')
      await host.downloadArchive(repo, sha, archivePath, this.opts.limits.maxArchiveBytes, signal)
      staging = await store.createStaging(repo.id)
      const result = await this.opts.runner(
        {
          archivePath,
          workDir,
          outDir: staging,
          repository: { id: repo.id, fullName: repo.fullName },
          commit,
          limits: this.opts.limits
        },
        stage,
        signal
      )
      if (signal.aborted || host.generation() !== generation) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Indexing was cancelled.')
      }
      const parsed = JSON.parse(await readFile(result.graphPath, 'utf8')) as SoftwareGraph
      const meta: ArtifactMeta = {
        repoId: repo.id,
        fullName: repo.fullName,
        sha,
        ref: commit.ref,
        analyzerConfigKey: configKey,
        status: result.status,
        completedAt: new Date().toISOString(),
        coverage: parsed.coverage
      }
      await store.publish(staging, meta)
      staging = null
      update(finished(repo, meta, false))
    } catch (e) {
      const message = signal.aborted
        ? `Cancelled: ${(signal.reason as Error)?.message ?? 'aborted'}`
        : ((e as Error)?.message ?? String(e))
      // Keep whatever graph was published before; only the attempt failed.
      if (host.generation() === generation) {
        await store
          .recordFailure(repo.id, { sha, error: message, at: new Date().toISOString() })
          .catch(() => {})
        this.set({ ...base(), state: 'failed', stage: undefined, error: message })
      }
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {})
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async statusFromDisk(repo: SourceRepo): Promise<IndexStatus> {
    const [latest, failure] = await Promise.all([
      this.opts.store.latest(repo.id),
      this.opts.store.lastFailure(repo.id)
    ])
    const lastIndexed = latest ? snapshotOf(latest, false) : null
    if (failure && (!latest || failure.at > latest.completedAt)) {
      return {
        repoId: repo.id,
        fullName: repo.fullName,
        state: 'failed',
        attemptSha: failure.sha,
        error: failure.error,
        lastIndexed
      }
    }
    return {
      repoId: repo.id,
      fullName: repo.fullName,
      state: latest ? latest.status : 'idle',
      lastIndexed
    }
  }

  private set(status: IndexStatus): void {
    this.statuses.set(status.repoId, status)
    this.opts.emit?.(status)
  }
}

function snapshotOf(meta: ArtifactMeta, cached: boolean): IndexedSnapshot {
  return {
    sha: meta.sha,
    ref: meta.ref,
    state: meta.status,
    completedAt: meta.completedAt,
    coverage: meta.coverage,
    cached
  }
}

function finished(repo: SourceRepo, meta: ArtifactMeta, cached: boolean): IndexStatus {
  return {
    repoId: repo.id,
    fullName: repo.fullName,
    state: meta.status,
    attemptSha: meta.sha,
    lastIndexed: snapshotOf(meta, cached)
  }
}

/** Runs each job in a forked Node process (Electron in Node mode) so the main thread stays free. */
export function forkRunner(workerPath: string): JobRunner {
  return (input, onStage, signal) =>
    new Promise((resolve, reject) => {
      // Minimal environment: no tokens or API keys reach the worker or scip-typescript.
      const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
      for (const k of [
        'PATH',
        'HOME',
        'TMPDIR',
        'TEMP',
        'TMP',
        'LANG',
        'SYSTEMROOT',
        'USERPROFILE'
      ]) {
        if (process.env[k]) env[k] = process.env[k]
      }
      const child = fork(workerPath, [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      let tail = ''
      const keep = (b: Buffer): void => {
        tail = (tail + b.toString('utf8')).slice(-4000)
      }
      child.stdout?.on('data', keep)
      child.stderr?.on('data', keep)
      let settled = false
      const abort = (): void => {
        child.kill('SIGKILL')
      }
      signal.addEventListener('abort', abort, { once: true })
      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        fn()
      }
      child.on('message', (m: WorkerMessage) => {
        if (m.type === 'stage') onStage(m.stage)
        else if (m.type === 'done') done(() => resolve(m.result))
        else if (m.type === 'error') done(() => reject(new Error(m.message)))
      })
      child.on('error', (e) => done(() => reject(e)))
      child.on('exit', (code, sig) =>
        done(() =>
          reject(
            new Error(`Indexer exited (${sig ?? code}) before finishing. ${tail.trim()}`.trim())
          )
        )
      )
      child.send(input)
    })
}
