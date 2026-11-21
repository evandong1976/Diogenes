/**
 * Postgres-backed design state: one document per project, changed inside a row-locked
 * transaction. The draft revision check in `DesignService.approve` therefore holds across
 * processes, not only within one.
 */
import { checkProjectId, emptyProjectState, type DesignStateStore } from '../design/store'
import type { ProjectState } from '../../shared/design'
import type { Database } from './db'

export class PgDesignStore implements DesignStateStore {
  constructor(private readonly db: Database) {}

  async read(projectId: string): Promise<ProjectState> {
    const id = checkProjectId(projectId)
    const { rows } = await this.db.query<{ state: ProjectState }>(
      'select state from private.dg_design_projects where project_id = $1',
      [id]
    )
    return rows[0]?.state ?? emptyProjectState(id)
  }

  update<T>(projectId: string, change: (state: ProjectState) => T): Promise<T> {
    const id = checkProjectId(projectId)
    return this.db.tx(async (q) => {
      await q.query(
        `insert into private.dg_design_projects (project_id, state) values ($1, $2::jsonb)
         on conflict (project_id) do nothing`,
        [id, JSON.stringify(emptyProjectState(id))]
      )
      const { rows } = await q.query<{ state: ProjectState }>(
        'select state from private.dg_design_projects where project_id = $1 for update',
        [id]
      )
      const state = rows[0].state
      // `change` may return part of `state`; serialize after it ran so both stay consistent.
      const result = change(state)
      await q.query(
        `update private.dg_design_projects
         set state = $2::jsonb, version = version + 1, updated_at = now() where project_id = $1`,
        [id, JSON.stringify(state)]
      )
      return structuredClone(result)
    })
  }
}
