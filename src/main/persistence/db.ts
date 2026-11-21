/**
 * Postgres connection for backend-owned state. Main process only: the connection string, the
 * password and the CA path never reach the renderer, Gemini, logs or error messages.
 *
 * TLS is always verified: the server certificate must chain to the configured root CA and match
 * the host name (`sslmode=verify-full`). A weaker or missing TLS setting is refused rather than
 * silently downgraded.
 */
import { readFileSync } from 'node:fs'
import pg from 'pg'

export const DATABASE_URL_ENV = 'DIOGENES_DATABASE_URL'

export type SqlValue = string | number | boolean | null | Date | Buffer | string[]

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: SqlValue[]
  ): Promise<pg.QueryResult<R>>
}

export class DatabaseConfigError extends Error {}

/** Thin pool wrapper. Every statement is parameterized; callers never interpolate values. */
export class Database implements Queryable {
  private closed = false

  constructor(private readonly pool: pg.Pool) {
    // An idle client error must not crash the main process; the next query reports it.
    pool.on('error', () => undefined)
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: SqlValue[] = []
  ): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(text, values)
  }

  /** Runs `fn` in one transaction on one connection. Rolls back if it throws. */
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const result = await fn({
        query: <R extends pg.QueryResultRow>(text: string, values: SqlValue[] = []) =>
          client.query<R>(text, values)
      })
      await client.query('commit')
      return result
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.pool.end()
  }
}

/** True when the backend must use Postgres. There is no in-memory or file fallback then. */
export function databaseConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env[DATABASE_URL_ENV]?.trim()
}

/**
 * Builds a pool from `DIOGENES_DATABASE_URL`. The root CA comes from the URL's `sslrootcert` or
 * from `PGSSLROOTCERT`. Errors name the missing setting, never its value.
 */
export function openDatabase(env: NodeJS.ProcessEnv = process.env): Database {
  const raw = env[DATABASE_URL_ENV]?.trim()
  if (!raw) throw new DatabaseConfigError(`${DATABASE_URL_ENV} is not set.`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new DatabaseConfigError(`${DATABASE_URL_ENV} is not a valid URL.`)
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    throw new DatabaseConfigError(`${DATABASE_URL_ENV} must be a postgres:// URL.`)
  const mode = url.searchParams.get('sslmode') ?? env.PGSSLMODE
  if (mode !== 'verify-full')
    throw new DatabaseConfigError('Database TLS must use sslmode=verify-full.')
  const caPath = url.searchParams.get('sslrootcert') ?? env.PGSSLROOTCERT
  if (!caPath) throw new DatabaseConfigError('Database TLS needs sslrootcert or PGSSLROOTCERT.')
  let ca: string
  try {
    ca = readFileSync(caPath, 'utf8')
  } catch {
    throw new DatabaseConfigError('The database root CA file could not be read.')
  }
  // TLS is configured explicitly below; drop libpq-only parameters so pg cannot override it.
  for (const key of [...url.searchParams.keys()])
    if (key.startsWith('ssl')) url.searchParams.delete(key)

  const pool = new pg.Pool({
    connectionString: url.toString(),
    // Default checkServerIdentity verifies the host name against the certificate.
    ssl: { ca, rejectUnauthorized: true, servername: url.hostname },
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    application_name: 'diogenes-backend'
  })
  return new Database(pool)
}
