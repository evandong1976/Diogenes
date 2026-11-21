import { randomUUID } from 'crypto'
import { mkdir, open, readdir, readFile, rename, rm } from 'fs/promises'
import { isDeepStrictEqual } from 'util'
import { join } from 'path'
import type {
  AppendOptions,
  AppendResult,
  CreateThreadInput,
  ProjectId,
  ThreadChange,
  ThreadErrorCode,
  ThreadEvent,
  ThreadEventInput,
  ThreadId,
  ThreadKind,
  ThreadProviderState,
  ThreadSnapshot,
  ThreadSummary,
  WorkRef
} from '../../shared/threads'

export class ThreadStoreError extends Error {
  constructor(
    readonly code: ThreadErrorCode,
    message: string
  ) {
    super(message)
  }
}

type ThreadFile = {
  version: 1
  thread: Omit<ThreadSummary, 'projectId' | 'lastSeq'>
  events: ThreadEvent[]
}

type Clock = { now: () => Date; newId: () => string }

export const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
export const THREAD_ID = /^thr_[A-Za-z0-9-]{1,64}$/
const EVENT = /^[A-Za-z0-9._:-]{1,128}$/
export const KINDS: readonly ThreadKind[] = ['design', 'coding']
const STATUSES = ['none', 'active', 'expired', 'failed', 'ended'] as const

/** What services need from a thread store. `ThreadStore` (files) and `PgThreadStore` implement it. */
export interface ThreadRepository {
  subscribe(listener: (change: ThreadChange) => void): () => void
  create(projectId: ProjectId, input: CreateThreadInput): Promise<ThreadSummary>
  list(projectId: ProjectId, filter?: { kind?: ThreadKind }): Promise<ThreadSummary[]>
  open(projectId: ProjectId, threadId: ThreadId): Promise<ThreadSnapshot>
  eventsSince(projectId: ProjectId, threadId: ThreadId, afterSeq: number): Promise<ThreadEvent[]>
  append(
    projectId: ProjectId,
    threadId: ThreadId,
    input: ThreadEventInput | ThreadEventInput[],
    options?: AppendOptions
  ): Promise<AppendResult>
  setProvider(
    projectId: ProjectId,
    threadId: ThreadId,
    state: Omit<ThreadProviderState, 'updatedAt'> | null
  ): Promise<ThreadSummary>
}

/**
 * Durable, project-scoped thread history. One JSON file per thread:
 *   <root>/<projectId>/<threadId>.json
 *
 * Every mutation re-reads the file, applies the change, and replaces the file atomically
 * (write temp, fsync, rename), so a reader or a restart only ever sees the previous or the
 * next complete version. Mutations to the same thread are serialized in-process; use one
 * store per userData directory (the app holds Electron's single-instance lock).
 */
export class ThreadStore implements ThreadRepository {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly listeners = new Set<(change: ThreadChange) => void>()
  private readonly clock: Clock

  constructor(
    private readonly root: string,
    clock: Partial<Clock> = {}
  ) {
    this.clock = { now: () => new Date(), newId: randomUUID, ...clock }
  }

  /** Called after each committed change. Returns an unsubscribe function. */
  subscribe(listener: (change: ThreadChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async create(projectId: ProjectId, input: CreateThreadInput): Promise<ThreadSummary> {
    if (!KINDS.includes(input?.kind)) throw invalid('Thread kind must be "design" or "coding".')
    const id = input.id ?? `thr_${this.clock.newId()}`
    const path = this.threadPath(projectId, id)
    return this.serialize(path, async () => {
      const existing = await readThread(path)
      if (existing) {
        if (existing.thread.kind !== input.kind) {
          throw new ThreadStoreError(
            'conflict',
            `Thread ${id} already exists as ${existing.thread.kind}.`
          )
        }
        return summarize(projectId, existing)
      }
      const at = this.clock.now().toISOString()
      const file: ThreadFile = {
        version: 1,
        thread: {
          id,
          kind: input.kind,
          title: typeof input.title === 'string' ? input.title.slice(0, 200) : '',
          createdAt: at,
          updatedAt: at,
          provider: null
        },
        events: []
      }
      await mkdir(join(this.root, projectId), { recursive: true })
      await atomicWrite(path, file)
      return this.emit(projectId, file, [])
    })
  }

  /** Threads in a project, most recently updated first. */
  async list(projectId: ProjectId, filter: { kind?: ThreadKind } = {}): Promise<ThreadSummary[]> {
    const dir = this.projectDir(projectId)
    const names = await readdir(dir).catch(() => [] as string[])
    const files = await Promise.all(
      names
        .filter((n) => n.endsWith('.json') && THREAD_ID.test(n.slice(0, -5)))
        .map((n) => readThread(join(dir, n)))
    )
    return files
      .filter((f): f is ThreadFile => f !== null && (!filter.kind || f.thread.kind === filter.kind))
      .map((f) => summarize(projectId, f))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  }

  /** Full transcript plus provider state, enough to restore the conversation offline. */
  async open(projectId: ProjectId, threadId: ThreadId): Promise<ThreadSnapshot> {
    const file = await this.require(projectId, threadId)
    return { ...summarize(projectId, file), events: file.events }
  }

  /** Events with `seq > afterSeq`; pair with `subscribe` to follow a thread. */
  async eventsSince(
    projectId: ProjectId,
    threadId: ThreadId,
    afterSeq: number
  ): Promise<ThreadEvent[]> {
    const file = await this.require(projectId, threadId)
    return file.events.filter((e) => e.seq > afterSeq)
  }

  /**
   * Appends events in order as one atomic write. An input whose `id` is already stored with
   * identical content returns the stored event instead of a new one.
   */
  async append(
    projectId: ProjectId,
    threadId: ThreadId,
    input: ThreadEventInput | ThreadEventInput[],
    options: AppendOptions = {}
  ): Promise<AppendResult> {
    const inputs = (Array.isArray(input) ? input : [input]).map(validateEvent)
    if (inputs.length === 0) throw invalid('Nothing to append.')
    const path = this.threadPath(projectId, threadId)
    return this.serialize(path, async () => {
      const file = await this.requireAt(path, threadId)
      const byId = new Map(file.events.map((e) => [e.id, e]))
      const events: ThreadEvent[] = []
      const duplicate: boolean[] = []
      const added: ThreadEvent[] = []
      for (const item of inputs) {
        const stored = item.id ? byId.get(item.id) : undefined
        if (stored) {
          if (!sameContent(stored, item)) {
            throw new ThreadStoreError(
              'conflict',
              `Event ${item.id} was already stored with different content.`
            )
          }
          events.push(stored)
          duplicate.push(true)
          continue
        }
        const event = {
          ...item,
          id: item.id ?? `evt_${this.clock.newId()}`,
          seq: file.events.length + added.length + 1,
          at: this.clock.now().toISOString()
        } as ThreadEvent
        byId.set(event.id, event)
        added.push(event)
        events.push(event)
        duplicate.push(false)
      }
      // A pure retry succeeds even if the thread moved on since.
      if (added.length === 0) return { thread: summarize(projectId, file), events, duplicate }
      if (options.expectedLastSeq !== undefined && options.expectedLastSeq !== file.events.length) {
        throw new ThreadStoreError(
          'stale',
          `Thread ${threadId} is at seq ${file.events.length}, expected ${options.expectedLastSeq}.`
        )
      }
      file.events.push(...added)
      file.thread.updatedAt = added[added.length - 1].at
      await atomicWrite(path, file)
      return { thread: this.emit(projectId, file, added), events, duplicate }
    })
  }

  /** Replaces provider continuation state. History is untouched. Pass null to clear it. */
  async setProvider(
    projectId: ProjectId,
    threadId: ThreadId,
    state: Omit<ThreadProviderState, 'updatedAt'> | null
  ): Promise<ThreadSummary> {
    const provider = state === null ? null : validateProvider(state, this.clock.now())
    const path = this.threadPath(projectId, threadId)
    return this.serialize(path, async () => {
      const file = await this.requireAt(path, threadId)
      file.thread.provider = provider
      await atomicWrite(path, file)
      return this.emit(projectId, file, [])
    })
  }

  private emit(projectId: ProjectId, file: ThreadFile, events: ThreadEvent[]): ThreadSummary {
    const thread = summarize(projectId, file)
    for (const listener of this.listeners) {
      try {
        listener({ projectId, threadId: thread.id, lastSeq: thread.lastSeq, events, thread })
      } catch {
        // A failing listener must not undo a committed write.
      }
    }
    return thread
  }

  private serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    const settled = next.catch(() => undefined)
    this.queues.set(key, settled)
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key)
    })
    return next
  }

  private async require(projectId: ProjectId, threadId: ThreadId): Promise<ThreadFile> {
    const path = this.threadPath(projectId, threadId)
    // Wait for queued writes so a read issued after an append sees it.
    await this.queues.get(path)
    return this.requireAt(path, threadId)
  }

  private async requireAt(path: string, threadId: ThreadId): Promise<ThreadFile> {
    const file = await readThread(path)
    if (!file) throw new ThreadStoreError('not_found', `Thread ${threadId} does not exist.`)
    return file
  }

  private projectDir(projectId: ProjectId): string {
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId))
      throw invalid('Invalid project ID.')
    return join(this.root, projectId)
  }

  private threadPath(projectId: ProjectId, threadId: ThreadId): string {
    if (typeof threadId !== 'string' || !THREAD_ID.test(threadId))
      throw invalid('Invalid thread ID.')
    return join(this.projectDir(projectId), `${threadId}.json`)
  }
}

function summarize(projectId: ProjectId, file: ThreadFile): ThreadSummary {
  return { projectId, ...file.thread, lastSeq: file.events.length }
}

export function invalid(message: string): ThreadStoreError {
  return new ThreadStoreError('invalid', message)
}

function content(event: ThreadEventInput | ThreadEvent): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, seq, at, ...rest } = event as ThreadEvent
  return rest
}

export function sameContent(stored: ThreadEvent, input: ThreadEventInput): boolean {
  return isDeepStrictEqual(content(stored), content(input))
}

const isText = (v: unknown, max = 200_000): v is string => typeof v === 'string' && v.length <= max

/** Checks shape at the boundary; inputs may arrive over IPC. Returns a JSON-clean copy. */
export function validateEvent(input: ThreadEventInput): ThreadEventInput {
  if (!input || typeof input !== 'object') throw invalid('Event must be an object.')
  if (input.id !== undefined && !(typeof input.id === 'string' && EVENT.test(input.id))) {
    throw invalid('Event ID must be 1–128 characters of [A-Za-z0-9._:-].')
  }
  switch (input.type) {
    case 'user_message':
      if (!isText(input.text)) throw invalid('user_message needs text.')
      if (
        input.context?.selectedComponentIds !== undefined &&
        !(
          Array.isArray(input.context.selectedComponentIds) &&
          input.context.selectedComponentIds.every((c) => isText(c, 256))
        )
      ) {
        throw invalid('selectedComponentIds must be strings.')
      }
      break
    case 'assistant_message':
      if (!isText(input.text)) throw invalid('assistant_message needs text.')
      if (input.model !== undefined && !isText(input.model, 200)) throw invalid('Invalid model.')
      break
    case 'tool_call':
      if (!isText(input.callId, 256) || !isText(input.name, 256))
        throw invalid('tool_call needs callId and name.')
      break
    case 'tool_result':
      if (!isText(input.callId, 256) || !isText(input.name, 256) || typeof input.ok !== 'boolean') {
        throw invalid('tool_result needs callId, name and ok.')
      }
      break
    case 'reference':
      if (input.note !== undefined && !isText(input.note, 2000)) throw invalid('Invalid note.')
      if (!input.refs?.length) throw invalid('reference needs at least one ref.')
      break
    default:
      throw invalid(`Unknown event type ${String((input as { type?: unknown }).type)}.`)
  }
  if (input.refs !== undefined) {
    if (!Array.isArray(input.refs) || !input.refs.every(validRef)) throw invalid('Invalid refs.')
  }
  try {
    return JSON.parse(JSON.stringify(input)) as ThreadEventInput
  } catch {
    throw invalid('Event must be JSON-serializable.')
  }
}

function validRef(ref: WorkRef): boolean {
  if (!ref || typeof ref !== 'object') return false
  switch (ref.kind) {
    case 'draftRevision':
      return isText(ref.draftId, 256) && Number.isSafeInteger(ref.revision) && ref.revision >= 0
    case 'proposal':
      return isText(ref.proposalId, 256)
    case 'handoff':
      return isText(ref.handoffId, 256)
    case 'codingRun':
      return isText(ref.runId, 256)
    case 'verdict':
      return isText(ref.verdictId, 256)
    default:
      return false
  }
}

export function validateProvider(
  state: Omit<ThreadProviderState, 'updatedAt'>,
  now: Date
): ThreadProviderState {
  if (!state || state.provider !== 'gemini' || !STATUSES.includes(state.status)) {
    throw invalid('Provider state needs provider "gemini" and a known status.')
  }
  for (const key of ['model', 'interactionId', 'environmentId', 'detail'] as const) {
    if (state[key] !== undefined && !isText(state[key], 2000)) throw invalid(`Invalid ${key}.`)
  }
  const { provider, status, model, interactionId, environmentId, detail } = state
  return JSON.parse(
    JSON.stringify({
      provider,
      status,
      model,
      interactionId,
      environmentId,
      detail,
      updatedAt: now.toISOString()
    })
  ) as ThreadProviderState
}

async function readThread(path: string): Promise<ThreadFile | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const file = JSON.parse(raw) as ThreadFile
  if (file.version !== 1) throw new Error(`Unsupported thread file version in ${path}.`)
  return file
}

/** Write a temp file, flush it to disk, then rename over the target. */
async function atomicWrite(path: string, data: ThreadFile): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(JSON.stringify(data))
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}
