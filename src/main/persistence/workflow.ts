/**
 * Postgres-backed workflow state. Approvals are immutable rows holding the exact packet bytes
 * (the table checks `approval_id = sha256(bytes)`). Each handoff save also appends its candidates
 * and verdicts to append-only ledgers in the same transaction, so every verification result
 * stays recoverable even after a re-verification replaces the handoff's latest verdict.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkflowRepository } from '../workflow/store'
import type {
  ApprovalRecord,
  ApprovedChange,
  HandoffRecord,
  Verdict,
  WorkflowCorrelation
} from '../../shared/workflow'
import type { Database } from './db'

interface ApprovalRow {
  approval_id: string
  correlation: WorkflowCorrelation
  packet_bytes: string
  approved_by: string
  approved_at: Date
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Stable ID of one verification result: the digest of its content. */
export const verdictId = (verdict: Verdict): string =>
  `vrd_${sha256(JSON.stringify(verdict)).slice(0, 40)}`

export class PgWorkflowStore implements WorkflowRepository {
  /**
   * @param cacheDir where packet bytes are written for the verifier. Files are re-checked
   *   against the approval ID before use, so a stale or edited cache is never trusted.
   */
  constructor(
    private readonly db: Database,
    private readonly cacheDir: string
  ) {}

  async approval(id: string): Promise<ApprovalRecord | undefined> {
    const { rows } = await this.db.query<ApprovalRow>(
      `select approval_id, correlation, packet_bytes, approved_by, approved_at
       from private.dg_approvals where approval_id = $1`,
      [id]
    )
    return rows[0] && toApproval(rows[0])
  }

  async putApproval(record: ApprovalRecord, bytes: string): Promise<ApprovalRecord> {
    if (sha256(bytes) !== record.approvalId)
      throw new Error(`Packet bytes do not hash to approval ${record.approvalId}.`)
    await this.db.query(
      `insert into private.dg_approvals
         (approval_id, project_id, proposal_id, correlation, packet_bytes, approved_by, approved_at)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7)
       on conflict (approval_id) do nothing`,
      [
        record.approvalId,
        record.correlation.projectId,
        record.correlation.proposalId,
        JSON.stringify(record.correlation),
        bytes,
        record.approvedBy,
        new Date(record.approvedAt)
      ]
    )
    return (await this.approval(record.approvalId))!
  }

  async packetFile(approvalId: string): Promise<string> {
    const path = join(this.cacheDir, 'approvals', `${approvalId}.json`)
    if (existsSync(path) && sha256(readFileSync(path, 'utf8')) === approvalId) return path
    const { rows } = await this.db.query<{ packet_bytes: string }>(
      'select packet_bytes from private.dg_approvals where approval_id = $1',
      [approvalId]
    )
    if (!rows[0]) throw new Error(`Unknown approval ${approvalId}.`)
    mkdirSync(join(this.cacheDir, 'approvals'), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, rows[0].packet_bytes)
    renameSync(tmp, path)
    return path
  }

  async handoff(id: string): Promise<HandoffRecord | undefined> {
    const { rows } = await this.db.query<{ record: HandoffRecord }>(
      'select record from private.dg_handoffs where handoff_id = $1',
      [id]
    )
    return rows[0]?.record
  }

  async putHandoff(h: HandoffRecord): Promise<void> {
    const projectId = h.correlation.projectId
    await this.db.tx(async (q) => {
      const saved = await q.query(
        `insert into private.dg_handoffs
           (handoff_id, project_id, approval_id, stage, record, created_at, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7)
         on conflict (handoff_id) do update
           set stage = excluded.stage, record = excluded.record, updated_at = excluded.updated_at
           where private.dg_handoffs.project_id = excluded.project_id
             and private.dg_handoffs.approval_id = excluded.approval_id
         returning handoff_id`,
        [
          h.handoffId,
          projectId,
          h.approvalId,
          h.stage,
          JSON.stringify(h),
          new Date(h.createdAt),
          new Date(h.updatedAt)
        ]
      )
      if (saved.rowCount !== 1)
        throw new Error(`Handoff ${h.handoffId} belongs to a different project or approval.`)
      for (const run of h.runs) {
        if (run.candidate)
          await q.query(
            `insert into private.dg_candidates
               (handoff_id, attempt, project_id, candidate_id, run_id, record)
             values ($1, $2, $3, $4, $5, $6::jsonb) on conflict do nothing`,
            [
              h.handoffId,
              run.attempt,
              projectId,
              run.candidate.candidateId,
              run.candidate.runId,
              JSON.stringify(run.candidate)
            ]
          )
        if (run.verdict)
          await q.query(
            `insert into private.dg_verdicts
               (verdict_id, project_id, handoff_id, approval_id, run_id, candidate_id, verifier,
                overall, verdict, verified_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10) on conflict do nothing`,
            [
              verdictId(run.verdict),
              projectId,
              h.handoffId,
              h.approvalId,
              run.verdict.runId,
              run.verdict.candidateId,
              run.verdict.verifier,
              run.verdict.overall,
              JSON.stringify(run.verdict),
              new Date(run.verdict.verifiedAt)
            ]
          )
      }
    })
  }

  async projectApprovals(projectId: string): Promise<ApprovalRecord[]> {
    const { rows } = await this.db.query<ApprovalRow>(
      `select approval_id, correlation, packet_bytes, approved_by, approved_at
       from private.dg_approvals where project_id = $1 order by approved_at`,
      [projectId]
    )
    return rows.map(toApproval)
  }

  async projectHandoffs(projectId: string): Promise<HandoffRecord[]> {
    const { rows } = await this.db.query<{ record: HandoffRecord }>(
      'select record from private.dg_handoffs where project_id = $1 order by created_at',
      [projectId]
    )
    return rows.map((r) => r.record)
  }

  /** Every verification result recorded for a handoff, oldest first. */
  async verdicts(
    projectId: string,
    handoffId: string
  ): Promise<(Verdict & { verdictId: string })[]> {
    const { rows } = await this.db.query<{ verdict_id: string; verdict: Verdict }>(
      `select verdict_id, verdict from private.dg_verdicts
       where project_id = $1 and handoff_id = $2 order by verified_at, verdict_id`,
      [projectId, handoffId]
    )
    return rows.map((r) => ({ ...r.verdict, verdictId: r.verdict_id }))
  }
}

function toApproval(row: ApprovalRow): ApprovalRecord {
  return {
    approvalId: row.approval_id,
    correlation: row.correlation,
    approvedAt: row.approved_at.toISOString(),
    approvedBy: row.approved_by,
    packet: JSON.parse(row.packet_bytes) as ApprovedChange
  }
}
