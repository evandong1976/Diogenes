/**
 * Electron wiring for the agent backend. The database URL, its password, the Gemini key and the
 * GitHub token stay in this process; the renderer gets typed, project-scoped calls only.
 */
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import exportScript from '../coding/export-candidate.mjs?raw'
import { createAntigravityProvider } from '../coding/antigravity'
import { DESIGN_MODELS, githubSourceReader } from '../design'
import { geminiModelClient } from '../design/model'
import { getAuthorizedRepo, githubFetch, githubGitAuthHeader, onSessionChange } from '../github'
import { readIndexedGraph } from '../indexing/ipc'
import { catalogVerifier, refundRetryVerifier, whiteboardVerifier } from '../workflow/verifiers'
import { GitMirror } from './repos'
import {
  createBackend,
  type AgentBackend,
  type ProjectAccess,
  type ProjectAuthorizer
} from './backend'
import { backendChannels as c, type BackendApi } from '../../shared/backend'

const ACCESS_TTL_MS = 5 * 60_000

/**
 * Reuses the GitHub session: a project is usable only when the signed-in account can read the
 * repository with that ID. Results are cached briefly and dropped on every sign-in change.
 */
export function githubAuthorizer(): ProjectAuthorizer {
  const cache = new Map<string, { access: ProjectAccess; at: number }>()
  let login: Promise<string> | null = null
  onSessionChange(() => {
    cache.clear()
    login = null
  })
  const account = (): Promise<string> =>
    (login ??= githubFetch('/user').then(async (res) => {
      if (!res.ok) throw new Error(`GitHub API ${res.status} reading the signed-in account`)
      return ((await res.json()) as { login: string }).login
    })).catch((error) => {
      login = null
      throw error
    })
  return {
    async authorize(projectId) {
      const hit = cache.get(projectId)
      if (hit && Date.now() - hit.at < ACCESS_TTL_MS) return hit.access
      const repo = await getAuthorizedRepo(Number(projectId))
      if (!repo) throw new Error(`The signed-in GitHub account cannot read project ${projectId}.`)
      const access: ProjectAccess = {
        projectId,
        repository: { id: repo.id, fullName: repo.fullName },
        account: await account()
      }
      cache.set(projectId, { access, at: Date.now() })
      return access
    }
  }
}

/**
 * Registers the handlers at once; they wait for the backend. If storage cannot open (for
 * example the database is configured but unreachable or unmigrated) every call rejects with
 * that reason. There is no fallback to local files while a database is configured.
 */
export function registerBackendIpc(): Promise<AgentBackend> {
  const ready = openBackend()
  ready.catch((error) => console.error(`Agent backend unavailable: ${describe(error)}`))
  const call =
    <A extends unknown[]>(fn: (backend: AgentBackend, ...args: A) => Promise<unknown>) =>
    async (...args: A): Promise<unknown> => {
      let backend: AgentBackend
      try {
        backend = await ready
      } catch (error) {
        // The cause is dropped on purpose: driver errors can name the database host.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`Agent backend unavailable: ${describe(error)}`)
      }
      return fn(backend, ...args)
    }
  registerHandlers(call)
  return ready
}

/** Error text safe for logs and the renderer: config errors and Postgres codes, no host or URL. */
function describe(error: unknown): string {
  const e = error as { name?: string; code?: string; message?: string }
  if (e?.name === 'DatabaseConfigError' || /migration/i.test(e?.message ?? '')) return e.message!
  return e?.code ? `database error ${e.code}` : 'storage could not be opened'
}

async function openBackend(): Promise<AgentBackend> {
  const backend = await createBackend({
    dataDir: join(app.getPath('userData'), 'backend'),
    authorizer: githubAuthorizer(),
    model: geminiModelClient(),
    models: DESIGN_MODELS,
    observedCatalog: async (repositoryId) =>
      (await readIndexedGraph(repositoryId))?.catalog ?? null,
    readSource: githubSourceReader,
    codingProvider: () => {
      const apiKey = process.env.GEMINI_API_KEY?.trim()
      if (!apiKey) throw new Error('GEMINI_API_KEY is missing from the main-process environment.')
      return createAntigravityProvider({ apiKey })
    },
    exportScript,
    // Base commits are fetched by SHA from the authorized GitHub repository with the session.
    repos: new GitMirror({
      root: join(app.getPath('userData'), 'backend', 'repos'),
      remoteUrl: (fullName) => `https://github.com/${fullName}.git`,
      authHeader: githubGitAuthHeader
    }),
    verifiers: [refundRetryVerifier(), catalogVerifier(), whiteboardVerifier()],
    // Additive, versioned and advisory-locked, so every app start may apply pending migrations.
    migrate: true
  })
  app.on('will-quit', () => void backend.close())
  return backend
}

type Call = <A extends unknown[]>(
  fn: (backend: AgentBackend, ...args: A) => Promise<unknown>
) => (...args: A) => Promise<unknown>

function registerHandlers(call: Call): void {
  const handlers: Record<
    (typeof c)[keyof typeof c],
    (backend: AgentBackend, ...args: never[]) => Promise<unknown>
  > = {
    [c.status]: (backend: AgentBackend) => backend.status(),
    [c.threadsCreate]: (backend: AgentBackend, p: string, input: object) =>
      backend.threads.create(p, plain(input)),
    [c.threadsList]: (backend: AgentBackend, p: string, filter?: object) =>
      backend.threads.list(p, filter === undefined ? {} : plain(filter)),
    [c.threadsOpen]: (backend: AgentBackend, p: string, t: string) => backend.threads.open(p, t),
    [c.threadsEventsSince]: (backend: AgentBackend, p: string, t: string, seq: number) =>
      backend.threads.eventsSince(p, t, int(seq)),
    [c.designOpenProject]: (backend: AgentBackend, p: string) => backend.design.openProject(p),
    [c.designGetProject]: (backend: AgentBackend, p: string) => backend.design.getProject(p),
    [c.designStartTurn]: (backend: AgentBackend, input: object) =>
      backend.design.startTurn(plain(input)),
    [c.designCancelTurn]: (backend: AgentBackend, p: string, turn: string) =>
      backend.design.cancelTurn(p, turn),
    [c.designReject]: (backend: AgentBackend, p: string, proposal: string, reason?: string) =>
      backend.design.reject(p, proposal, typeof reason === 'string' ? reason : undefined),
    [c.designApprove]: (backend: AgentBackend, p: string, proposal: string, rev: number) =>
      backend.design.approve(p, proposal, int(rev)),
    [c.workflowPreview]: (backend: AgentBackend, request: object) =>
      backend.workflow.preview(plain(request)),
    [c.workflowGetProject]: (backend: AgentBackend, p: string) => backend.workflow.getProject(p),
    [c.workflowStartHandoff]: (backend: AgentBackend, p: string, a: string) =>
      backend.workflow.startHandoff(p, a),
    [c.workflowBuildWhiteboard]: (backend: AgentBackend, p: string, t: string) =>
      backend.workflow.buildWhiteboard(p, t),
    [c.workflowGetHandoff]: (backend: AgentBackend, p: string, h: string) =>
      backend.workflow.getHandoff(p, h),
    [c.workflowRefresh]: (backend: AgentBackend, p: string, h: string) =>
      backend.workflow.refresh(p, h),
    [c.workflowSteer]: (backend: AgentBackend, p: string, h: string, m: string) =>
      backend.workflow.steer(p, h, m),
    [c.workflowCancel]: (backend: AgentBackend, p: string, h: string) =>
      backend.workflow.cancel(p, h),
    [c.workflowRequestCorrection]: (backend: AgentBackend, p: string, h: string, r: object) => {
      const req = plain<{ obligationIds: unknown; instructions: unknown }>(r)
      if (!Array.isArray(req.obligationIds) || typeof req.instructions !== 'string')
        throw new Error('Expected obligationIds and instructions.')
      return backend.workflow.requestCorrection(p, h, req as never)
    },
    [c.workflowResolveDecision]: (backend: AgentBackend, p: string, h: string, o: string) =>
      backend.workflow.resolveDecision(p, h, o as never),
    [c.workflowVerdicts]: (backend: AgentBackend, p: string, h: string) =>
      backend.workflow.verdicts(p, h),
    [c.codingList]: (backend: AgentBackend, p: string) => backend.coding.list(p),
    [c.codingStatus]: (backend: AgentBackend, p: string, r: string) => backend.coding.status(p, r),
    [c.codingRetry]: (backend: AgentBackend, p: string, r: string) => backend.coding.retry(p, r),
    [c.codingCancel]: (backend: AgentBackend, p: string, r: string) => backend.coding.cancel(p, r)
  }
  for (const [channel, handler] of Object.entries(handlers)) {
    const run = call((backend: AgentBackend, ...args: unknown[]) =>
      (handler as (b: AgentBackend, ...a: unknown[]) => Promise<unknown>)(backend, ...args)
    )
    ipcMain.handle(channel, (_event, ...args) => run(...args))
  }
}

/** Arguments from the renderer are data: plain objects only, never prototypes or functions. */
function plain<T>(value: unknown): T {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object.')
  return structuredClone(value) as T
}

function int(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error('Expected an integer.')
  return value as number
}

export type { BackendApi }
