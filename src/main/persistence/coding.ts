/**
 * Postgres-backed managed coding runs. The frozen start input is written once (a trigger rejects
 * changes to it); the run record, its phase and its continuation references (environment and
 * latest interaction) are rewritten on every change.
 */
import type { CodingRunRepository } from '../coding/store'
import type { CodingRunView, StartCodingRun } from '../../shared/codingRun'
import type { Database } from './db'

const RUN_ID = /^run_[0-9a-f]{32}$/

function checkRunId(runId: unknown): string {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new Error('Invalid coding run ID.')
  return runId
}

/** The newest interaction ID of a run, used as `previous_interaction_id` on the next turn. */
const lastInteraction = (run: CodingRunView): string | null =>
  run.turns.findLast((t) => t.interactionId)?.interactionId ?? null

export class PgCodingRunStore implements CodingRunRepository {
  /** @param projectId when set, reads and lists only see runs of this project. */
  constructor(
    private readonly db: Database,
    private readonly projectId?: string
  ) {}

  /** A view of the same table limited to one project. */
  forProject(projectId: string): PgCodingRunStore {
    return new PgCodingRunStore(this.db, projectId)
  }

  async create(run: CodingRunView, input: StartCodingRun): Promise<void> {
    const projectId = String(input.handoff.repository.id)
    if (this.projectId !== undefined && projectId !== this.projectId)
      throw new Error(`Run ${run.runId} is for project ${projectId}, not ${this.projectId}.`)
    await this.db.query(
      `insert into private.dg_coding_runs
         (run_id, project_id, handoff_id, input, run, phase, environment_id, last_interaction_id,
          created_at, updated_at)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)`,
      [
        checkRunId(run.runId),
        projectId,
        run.handoffId,
        JSON.stringify(input),
        JSON.stringify(run),
        run.phase,
        run.environmentId ?? null,
        lastInteraction(run),
        new Date(run.createdAt),
        new Date(run.updatedAt)
      ]
    )
  }

  async save(run: CodingRunView): Promise<void> {
    const { rowCount } = await this.db.query(
      `update private.dg_coding_runs
       set run = $2::jsonb, phase = $3, environment_id = $4, last_interaction_id = $5,
           updated_at = $6
       where run_id = $1 and handoff_id = $7 and ($8::text is null or project_id = $8)`,
      [
        checkRunId(run.runId),
        JSON.stringify(run),
        run.phase,
        run.environmentId ?? null,
        lastInteraction(run),
        new Date(run.updatedAt),
        run.handoffId,
        this.projectId ?? null
      ]
    )
    if (rowCount !== 1) throw new Error(`Coding run ${run.runId} is not stored.`)
  }

  async read(runId: string): Promise<CodingRunView | null> {
    const { rows } = await this.db.query<{ run: CodingRunView }>(
      `select run from private.dg_coding_runs
       where run_id = $1 and ($2::text is null or project_id = $2)`,
      [checkRunId(runId), this.projectId ?? null]
    )
    return rows[0]?.run ?? null
  }

  async input(runId: string): Promise<StartCodingRun | null> {
    const { rows } = await this.db.query<{ input: StartCodingRun }>(
      `select input from private.dg_coding_runs
       where run_id = $1 and ($2::text is null or project_id = $2)`,
      [checkRunId(runId), this.projectId ?? null]
    )
    return rows[0]?.input ?? null
  }

  async list(): Promise<CodingRunView[]> {
    const { rows } = await this.db.query<{ run: CodingRunView }>(
      `select run from private.dg_coding_runs
       where ($1::text is null or project_id = $1) order by created_at`,
      [this.projectId ?? null]
    )
    return rows.map((r) => r.run)
  }

  /** Project that owns a run, or null when the run is unknown. */
  async projectOf(runId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ project_id: string }>(
      'select project_id from private.dg_coding_runs where run_id = $1',
      [checkRunId(runId)]
    )
    return rows[0]?.project_id ?? null
  }
}
