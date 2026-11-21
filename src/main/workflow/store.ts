/**
 * Durable workflow state: one JSON document replaced atomically, plus the exact bytes of each
 * frozen approval packet, which the verifier digests.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalRecord, HandoffRecord } from '../../shared/workflow'

interface State {
  version: 1
  approvals: Record<string, ApprovalRecord>
  handoffs: Record<string, HandoffRecord>
}

export class WorkflowStore {
  private state: State

  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'approvals'), { recursive: true })
    const file = join(dir, 'state.json')
    this.state = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as State)
      : { version: 1, approvals: {}, handoffs: {} }
  }

  packetPath(approvalId: string): string {
    return join(this.dir, 'approvals', `${approvalId}.json`)
  }

  writePacket(approvalId: string, bytes: string): void {
    const path = this.packetPath(approvalId)
    if (!existsSync(path)) atomicWrite(path, bytes)
  }

  approval(id: string): ApprovalRecord | undefined {
    return this.state.approvals[id]
  }

  handoff(id: string): HandoffRecord | undefined {
    return this.state.handoffs[id]
  }

  approvals(): ApprovalRecord[] {
    return Object.values(this.state.approvals)
  }

  handoffs(): HandoffRecord[] {
    return Object.values(this.state.handoffs)
  }

  putApproval(record: ApprovalRecord): void {
    this.state.approvals[record.approvalId] = record
    this.save()
  }

  putHandoff(record: HandoffRecord): void {
    this.state.handoffs[record.handoffId] = record
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
