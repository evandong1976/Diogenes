/** In-memory stand-ins for the design thread (Session 1) and coding gateway (Session 3). */
import type {
  CandidateBundle,
  CandidateFile,
  CodingGateway,
  CodingHandoff,
  CodingRunSnapshot,
  DesignThreadSink,
  ThreadMessage
} from '../../src/shared/workflow'

export class FakeThreads implements DesignThreadSink {
  readonly messages: { threadId: string; message: ThreadMessage }[] = []
  async post(threadId: string, message: ThreadMessage): Promise<void> {
    this.messages.push({ threadId, message })
  }
  last<K extends ThreadMessage['kind']>(kind: K): Extract<ThreadMessage, { kind: K }> | undefined {
    return this.messages.map((m) => m.message).findLast((m) => m.kind === kind) as
      Extract<ThreadMessage, { kind: K }> | undefined
  }
}

/**
 * Every run reports `completed` and claims success, whatever it produced. `produce` decides the
 * files for each submitted handoff; `tamper` lets a test corrupt the returned bundle.
 */
export class FakeGateway implements CodingGateway {
  readonly submitted: CodingHandoff[] = []
  private runs = new Map<string, { snap: CodingRunSnapshot; handoff: CodingHandoff }>()

  constructor(
    private readonly produce: (handoff: CodingHandoff) => CandidateFile[],
    private readonly tamper: (bundle: CandidateBundle) => CandidateBundle = (b) => b
  ) {}

  async submit(handoff: CodingHandoff): Promise<CodingRunSnapshot> {
    this.submitted.push(handoff)
    const snap: CodingRunSnapshot = {
      runId: `run-${handoff.handoffId}-${handoff.attempt}`,
      handoffId: handoff.handoffId,
      approvalId: handoff.approvalId,
      status: 'running',
      remoteStatus: 'in_progress',
      events: [{ at: new Date().toISOString(), kind: 'status', text: 'in_progress' }]
    }
    this.runs.set(snap.runId, { snap, handoff })
    return structuredClone(snap)
  }

  async get(runId: string): Promise<CodingRunSnapshot> {
    const { snap } = this.run(runId)
    if (snap.status === 'running') {
      snap.status = 'completed'
      snap.remoteStatus = 'completed'
      snap.events.push({ at: new Date().toISOString(), kind: 'message', text: 'All checks pass.' })
    }
    return structuredClone(snap)
  }

  async steer(runId: string, message: string): Promise<CodingRunSnapshot> {
    this.run(runId).snap.events.push({ at: new Date().toISOString(), kind: 'steer', text: message })
    return structuredClone(this.run(runId).snap)
  }

  async cancel(runId: string): Promise<CodingRunSnapshot> {
    this.run(runId).snap.status = 'cancelled'
    return structuredClone(this.run(runId).snap)
  }

  async retrieveCandidate(runId: string): Promise<CandidateBundle> {
    const { snap, handoff } = this.run(runId)
    if (snap.status !== 'completed') throw new Error(`${runId} is ${snap.status}`)
    return this.tamper({
      runId,
      handoffId: handoff.handoffId,
      approvalId: handoff.approvalId,
      baseCommit: handoff.baseCommit,
      files: this.produce(handoff),
      deleted: [],
      remoteClaim: 'Implemented the approved change. All checks pass.'
    })
  }

  private run(runId: string): { snap: CodingRunSnapshot; handoff: CodingHandoff } {
    const run = this.runs.get(runId)
    if (!run) throw new Error(`Unknown run ${runId}`)
    return run
  }
}
