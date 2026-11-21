/**
 * Versioned, additive migrations for backend-owned tables in the `private` schema. Applied in
 * order under an advisory lock, each in its own transaction, and recorded with a checksum in
 * `private.dg_schema_migrations`. The Supabase CLI history (`supabase_migrations`) is left alone.
 */
import { createHash } from 'node:crypto'
import backendState from './migrations/0001_backend_state.sql?raw'
import type { Database } from './db'

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [{ version: 1, name: 'backend_state', sql: backendState }]

export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.version

const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex')
// Any constant works; it only has to be the same in every Diogenes process.
const LOCK_KEY = 0x64696f67

const TRACKING = `create table if not exists private.dg_schema_migrations (
  version integer primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now()
)`

/** Applies pending migrations. Returns the versions this call applied. */
export async function migrate(db: Database): Promise<number[]> {
  return db.tx(async (q) => {
    await q.query('select pg_advisory_xact_lock($1)', [LOCK_KEY])
    await q.query('create schema if not exists private')
    await q.query(TRACKING)
    await q.query('alter table private.dg_schema_migrations enable row level security')
    const { rows } = await q.query<{ version: number; checksum: string }>(
      'select version, checksum from private.dg_schema_migrations'
    )
    const done = new Map(rows.map((r) => [r.version, r.checksum]))
    const applied: number[] = []
    for (const m of MIGRATIONS) {
      const recorded = done.get(m.version)
      if (recorded !== undefined) {
        if (recorded !== checksum(m.sql))
          throw new Error(`Migration ${m.version} (${m.name}) changed after it was applied.`)
        continue
      }
      await q.query(m.sql)
      await q.query(
        'insert into private.dg_schema_migrations (version, name, checksum) values ($1, $2, $3)',
        [m.version, m.name, checksum(m.sql)]
      )
      applied.push(m.version)
    }
    return applied
  })
}

/** Throws unless every known migration is recorded. Services call this instead of migrating. */
export async function assertMigrated(db: Database): Promise<void> {
  const { rows } = await db
    .query<{ version: number }>('select version from private.dg_schema_migrations')
    .catch(() => ({ rows: [] as { version: number }[] }))
  const have = new Set(rows.map((r) => r.version))
  const missing = MIGRATIONS.filter((m) => !have.has(m.version)).map((m) => m.version)
  if (missing.length)
    throw new Error(
      `The Diogenes database schema is missing migration(s) ${missing.join(', ')}. Run pnpm db:migrate.`
    )
}
