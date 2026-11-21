/**
 * Adapters from the design harness and the workflow to the persistent thread store.
 *
 * Every event they append carries a deterministic ID, so a retried turn or a re-delivered
 * workflow message deduplicates instead of appearing twice.
 */
import { createHash } from 'node:crypto'
import type { ThreadHistory, ThreadMessage as DesignMessage } from '../design/history'
import type { ThreadRepository } from '../threads/store'
import type { ThreadEventInput, WorkRef } from '../../shared/threads'
import type { DesignThreadSink, ThreadMessage, WorkflowCorrelation } from '../../shared/workflow'
import { verdictId } from '../persistence/workflow'

const TURN_EVENT = /^turn:(.+):(developer|assistant)$/
const short = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 24)

/** The design harness's conversation history, kept in the project's design thread. */
export class StoredThreadHistory implements ThreadHistory {
  constructor(private readonly threads: ThreadRepository) {}

  async read(projectId: string, threadId: string): Promise<DesignMessage[]> {
    const { events } = await this.threads.open(projectId, threadId)
    const messages: DesignMessage[] = []
    for (const e of events) {
      const turnId = TURN_EVENT.exec(e.id)?.[1] ?? e.id
      if (e.type === 'user_message')
        messages.push({ role: 'developer', text: e.text, turnId, at: e.at })
      else if (e.type === 'assistant_message')
        messages.push({ role: 'assistant', text: e.text, turnId, at: e.at, model: e.model })
    }
    return messages
  }

  async append(projectId: string, threadId: string, message: DesignMessage): Promise<void> {
    const id = `turn:${message.turnId}:${message.role}`
    const event: ThreadEventInput =
      message.role === 'developer'
        ? { id, type: 'user_message', text: message.text }
        : {
            id,
            type: 'assistant_message',
            text: message.text,
            ...(message.model && { model: message.model })
          }
    await this.threads.append(projectId, threadId, event)
  }
}

/** Workflow results posted to the design thread as references to the records that own them. */
export class StoredWorkflowSink implements DesignThreadSink {
  constructor(private readonly threads: ThreadRepository) {}

  async post(
    threadId: string,
    message: ThreadMessage,
    correlation: WorkflowCorrelation
  ): Promise<void> {
    await this.threads.append(correlation.projectId, threadId, referenceEvent(message, correlation))
  }
}

export function referenceEvent(
  message: ThreadMessage,
  correlation: WorkflowCorrelation
): ThreadEventInput {
  const refs: WorkRef[] = [
    { kind: 'proposal', proposalId: correlation.proposalId },
    { kind: 'handoff', handoffId: message.handoffId }
  ]
  switch (message.kind) {
    case 'run':
      refs.push({ kind: 'codingRun', runId: message.runId })
      return {
        id: `wf:${message.handoffId}:run:${message.runId}:${message.status}`,
        type: 'reference',
        note: `Coding run ${message.runId} is ${message.status}${message.detail ? `: ${message.detail}` : ''}`,
        refs
      }
    case 'verdict': {
      const vid = verdictId(message.verdict)
      refs.push({ kind: 'codingRun', runId: message.runId }, { kind: 'verdict', verdictId: vid })
      const open = message.verdict.obligations
        .filter((o) => o.outcome !== 'pass')
        .map((o) => `${o.id} ${o.outcome}${o.unknownReason ? ` (${o.unknownReason})` : ''}`)
      return {
        id: `wf:${message.handoffId}:verdict:${vid}`,
        type: 'reference',
        note: `Local verification of candidate ${message.candidateId.slice(0, 12)}: ${message.verdict.overall}${open.length ? ` — ${open.join(', ')}` : ''}`,
        refs
      }
    }
    case 'decision':
      return {
        id: `wf:${message.handoffId}:decision:${short(`${message.reason}\n${message.detail}`)}`,
        type: 'reference',
        note: `Decision needed (${message.reason}): ${message.detail.slice(0, 1500)}`,
        refs
      }
  }
}
