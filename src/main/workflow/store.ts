/**
 * Durable workflow state. `WorkflowRepository` is what the service needs; `WorkflowStore` keeps it
 * in one JSON document plus the exact bytes of each frozen approval packet, and
 * `PgWorkflowStore` (src/main/persistence) keeps it in Postgres.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalRecord, HandoffRecord } from '../../shared/workflow'

export interface WorkflowRepository {
  approval(id: string): Promise<ApprovalRecord | undefined>
  /**
   * Stores a frozen approval with its exact packet bytes unless one with this ID exists.
   * Returns the stored record, which is the earlier one on a repeat.
   */
  putApproval(record: ApprovalRecord, bytes: string): Promise<ApprovalRecord>
  /** A local file holding the exact packet bytes, for the verifier to digest. */
  packetFile(approvalId: string): Promise<string>
  handoff(id: string): Promise<HandoffRecord | undefined>
  putHandoff(record: HandoffRecord): Promise<void>
  projectApprovals(projectId: string): Promise<ApprovalRecord[]>
  projectHandoffs(projectId: string): Promise<HandoffRecord[]>
}

interface State {
  version: 1
  approvals: Record<string, ApprovalRecord>
  handoffs: Record<string, HandoffRecord>
}

export class WorkflowStore implements WorkflowRepository {
  private state: State

  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'approvals'), { recursive: true })
    const file = join(dir, 'state.json')
    this.state = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as State)
      : { version: 1, approvals: {}, handoffs: {} }
  }

  async packetFile(approvalId: string): Promise<string> {
    return join(this.dir, 'approvals', `${approvalId}.json`)
  }

  async approval(id: string): Promise<ApprovalRecord | undefined> {
    return this.state.approvals[id]
  }

  async handoff(id: string): Promise<HandoffRecord | undefined> {
    return this.state.handoffs[id]
  }

  async projectApprovals(projectId: string): Promise<ApprovalRecord[]> {
    return Object.values(this.state.approvals).filter((a) => a.correlation.projectId === projectId)
  }

  async projectHandoffs(projectId: string): Promise<HandoffRecord[]> {
    return Object.values(this.state.handoffs)
      .filter((h) => h.correlation.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async putApproval(record: ApprovalRecord, bytes: string): Promise<ApprovalRecord> {
    const existing = this.state.approvals[record.approvalId]
    if (existing) return existing
    const path = await this.packetFile(record.approvalId)
    if (!existsSync(path)) atomicWrite(path, bytes)
    this.state.approvals[record.approvalId] = record
    this.save()
    return record
  }

  async putHandoff(record: HandoffRecord): Promise<void> {
    this.state.handoffs[record.handoffId] = structuredClone(record)
    this.save()
  }

  private save(): void {
    atomicWrite(join(this.dir, 'state.json'), JSON.stringify(this.state, null, 2))
  }
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}
