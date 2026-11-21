/**
 * Postgres-backed thread store with the same contract as the file `ThreadStore`: gapless `seq`,
 * idempotent appends keyed by event ID, `expectedLastSeq` for writers that must not interleave.
 * The thread row is locked for each write, so several processes can share one database.
 */
import { randomUUID } from 'node:crypto'
import {
  KINDS,
  THREAD_ID,
  PROJECT_ID,
  ThreadStoreError,
  invalid,
  sameContent,
  validateEvent,
  validateProvider,
  type ThreadRepository
} from '../threads/store'
import type {
  AppendOptions,
  AppendResult,
  CreateThreadInput,
  ProjectId,
  ThreadChange,
  ThreadEvent,
  ThreadEventInput,
  ThreadId,
  ThreadKind,
  ThreadProviderState,
  ThreadSnapshot,
  ThreadSummary
} from '../../shared/threads'
import type { Database, Queryable } from './db'

interface ThreadRow {
  project_id: string
  thread_id: string
  kind: ThreadKind
  title: string
  provider: ThreadProviderState | null
  last_seq: number
  created_at: Date
  updated_at: Date
}

interface EventRow {
  seq: number
  event_id: string
  body: Record<string, unknown>
  at: Date
}

type Clock = { now: () => Date; newId: () => string }

const THREAD_COLUMNS =
  'project_id, thread_id, kind, title, provider, last_seq, created_at, updated_at'

export class PgThreadStore implements ThreadRepository {
  private readonly listeners = new Set<(change: ThreadChange) => void>()
  private readonly clock: Clock

  constructor(
    private readonly db: Database,
    clock: Partial<Clock> = {}
  ) {
    this.clock = { now: () => new Date(), newId: randomUUID, ...clock }
  }

  subscribe(listener: (change: ThreadChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async create(projectId: ProjectId, input: CreateThreadInput): Promise<ThreadSummary> {
    checkProject(projectId)
    if (!KINDS.includes(input?.kind)) throw invalid('Thread kind must be "design" or "coding".')
    const id = input.id ?? `thr_${this.clock.newId()}`
    checkThread(id)
    const at = this.clock.now()
    const title = typeof input.title === 'string' ? input.title.slice(0, 200) : ''
    const inserted = await this.db.query<ThreadRow>(
      `insert into private.dg_threads (project_id, thread_id, kind, title, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $5)
       on conflict (project_id, thread_id) do nothing
       returning ${THREAD_COLUMNS}`,
      [projectId, id, input.kind, title, at]
    )
    if (inserted.rows[0]) return this.emit(summary(inserted.rows[0]), [])
    const existing = await this.row(this.db, projectId, id)
    if (!existing) throw new Error(`Thread ${id} could not be created.`)
    if (existing.kind !== input.kind)
      throw new ThreadStoreError('conflict', `Thread ${id} already exists as ${existing.kind}.`)
    return summary(existing)
  }

  async list(projectId: ProjectId, filter: { kind?: ThreadKind } = {}): Promise<ThreadSummary[]> {
    checkProject(projectId)
    const { rows } = await this.db.query<ThreadRow>(
      `select ${THREAD_COLUMNS} from private.dg_threads
       where project_id = $1 and ($2::text is null or kind = $2)
       order by updated_at desc, thread_id`,
      [projectId, filter.kind ?? null]
    )
    return rows.map(summary)
  }

  async open(projectId: ProjectId, threadId: ThreadId): Promise<ThreadSnapshot> {
    const row = await this.require(this.db, projectId, threadId)
    return { ...summary(row), events: await this.events(this.db, projectId, threadId, 0) }
  }

  async eventsSince(
    projectId: ProjectId,
    threadId: ThreadId,
    afterSeq: number
  ): Promise<ThreadEvent[]> {
    await this.require(this.db, projectId, threadId)
    return this.events(this.db, projectId, threadId, Number.isSafeInteger(afterSeq) ? afterSeq : 0)
  }

  async append(
    projectId: ProjectId,
    threadId: ThreadId,
    input: ThreadEventInput | ThreadEventInput[],
    options: AppendOptions = {}
  ): Promise<AppendResult> {
    const inputs = (Array.isArray(input) ? input : [input]).map(validateEvent)
    if (inputs.length === 0) throw invalid('Nothing to append.')
    const committed = await this.db.tx(async (q) => {
      const row = await this.require(q, projectId, threadId, true)
      const ids = inputs.map((i) => i.id).filter((id): id is string => !!id)
      const stored = new Map<string, ThreadEvent>()
      if (ids.length) {
        const { rows } = await q.query<EventRow>(
          `select seq, event_id, body, at from private.dg_thread_events
           where project_id = $1 and thread_id = $2 and event_id = any($3::text[])`,
          [projectId, threadId, ids]
        )
        for (const r of rows) stored.set(r.event_id, toEvent(r))
      }
      const events: ThreadEvent[] = []
      const duplicate: boolean[] = []
      const added: ThreadEvent[] = []
      for (const item of inputs) {
        const prior = item.id ? stored.get(item.id) : undefined
        if (prior) {
          if (!sameContent(prior, item))
            throw new ThreadStoreError(
              'conflict',
              `Event ${item.id} was already stored with different content.`
            )
          events.push(prior)
          duplicate.push(true)
          continue
        }
        const event = {
          ...item,
          id: item.id ?? `evt_${this.clock.newId()}`,
          seq: row.last_seq + added.length + 1,
          at: this.clock.now().toISOString()
        } as ThreadEvent
        stored.set(event.id, event)
        added.push(event)
        events.push(event)
        duplicate.push(false)
      }
      if (added.length === 0) return { row, events, duplicate, added }
      if (options.expectedLastSeq !== undefined && options.expectedLastSeq !== row.last_seq)
        throw new ThreadStoreError(
          'stale',
          `Thread ${threadId} is at seq ${row.last_seq}, expected ${options.expectedLastSeq}.`
        )
      for (const e of added) {
        const { id, seq, at, ...body } = e
        await q.query(
          `insert into private.dg_thread_events (project_id, thread_id, seq, event_id, body, at)
           values ($1, $2, $3, $4, $5::jsonb, $6)`,
          [projectId, threadId, seq, id, JSON.stringify(body), at]
        )
      }
      const updated = await q.query<ThreadRow>(
        `update private.dg_threads set last_seq = $3, updated_at = $4
         where project_id = $1 and thread_id = $2 returning ${THREAD_COLUMNS}`,
        [projectId, threadId, row.last_seq + added.length, added.at(-1)!.at]
      )
      return { row: updated.rows[0], events, duplicate, added }
    })
    const thread = summary(committed.row)
    if (committed.added.length) this.emit(thread, committed.added)
    return { thread, events: committed.events, duplicate: committed.duplicate }
  }

  async setProvider(
    projectId: ProjectId,
    threadId: ThreadId,
    state: Omit<ThreadProviderState, 'updatedAt'> | null
  ): Promise<ThreadSummary> {
    checkProject(projectId)
    checkThread(threadId)
    const provider = state === null ? null : validateProvider(state, this.clock.now())
    const { rows } = await this.db.query<ThreadRow>(
      `update private.dg_threads set provider = $3::jsonb
       where project_id = $1 and thread_id = $2 returning ${THREAD_COLUMNS}`,
      [projectId, threadId, provider === null ? null : JSON.stringify(provider)]
    )
    if (!rows[0]) throw new ThreadStoreError('not_found', `Thread ${threadId} does not exist.`)
    return this.emit(summary(rows[0]), [])
  }

  private async row(
    q: Queryable,
    projectId: string,
    threadId: string,
    lock = false
  ): Promise<ThreadRow | undefined> {
    const { rows } = await q.query<ThreadRow>(
      `select ${THREAD_COLUMNS} from private.dg_threads
       where project_id = $1 and thread_id = $2${lock ? ' for update' : ''}`,
      [projectId, threadId]
    )
    return rows[0]
  }

  private async require(
    q: Queryable,
    projectId: string,
    threadId: string,
    lock = false
  ): Promise<ThreadRow> {
    checkProject(projectId)
    checkThread(threadId)
    const row = await this.row(q, projectId, threadId, lock)
    if (!row) throw new ThreadStoreError('not_found', `Thread ${threadId} does not exist.`)
    return row
  }

  private async events(
    q: Queryable,
    projectId: string,
    threadId: string,
    afterSeq: number
  ): Promise<ThreadEvent[]> {
    const { rows } = await q.query<EventRow>(
      `select seq, event_id, body, at from private.dg_thread_events
       where project_id = $1 and thread_id = $2 and seq > $3 order by seq`,
      [projectId, threadId, afterSeq]
    )
    return rows.map(toEvent)
  }

  private emit(thread: ThreadSummary, events: ThreadEvent[]): ThreadSummary {
    for (const listener of this.listeners) {
      try {
        listener({
          projectId: thread.projectId,
          threadId: thread.id,
          lastSeq: thread.lastSeq,
          events,
          thread
        })
      } catch {
        // A failing listener must not undo a committed write.
      }
    }
    return thread
  }
}

function checkProject(projectId: unknown): void {
  if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId))
    throw invalid('Invalid project ID.')
}

function checkThread(threadId: unknown): void {
  if (typeof threadId !== 'string' || !THREAD_ID.test(threadId)) throw invalid('Invalid thread ID.')
}

function summary(row: ThreadRow): ThreadSummary {
  return {
    projectId: row.project_id,
    id: row.thread_id,
    kind: row.kind,
    title: row.title,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastSeq: row.last_seq,
    provider: row.provider
  }
}

function toEvent(row: EventRow): ThreadEvent {
  return { ...row.body, id: row.event_id, seq: row.seq, at: row.at.toISOString() } as ThreadEvent
}
