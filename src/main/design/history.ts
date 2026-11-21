// Conversation history is owned by the thread service (Session 1). The harness needs only this
// much of it: read a thread's messages in order and append the turn's messages. Messages are
// model-neutral text, so a thread can continue on a different model than the one that wrote it.

export interface ThreadMessage {
  role: 'developer' | 'assistant'
  text: string
  turnId: string
  /** The model that wrote an assistant message. */
  model?: string
  at: string
}

export interface ThreadHistory {
  read(projectId: string, threadId: string): Promise<ThreadMessage[]>
  append(projectId: string, threadId: string, message: ThreadMessage): Promise<void>
}

/** Stand-in until the thread service is wired. Also used by tests. */
export class MemoryThreadHistory implements ThreadHistory {
  private readonly threads = new Map<string, ThreadMessage[]>()

  async read(projectId: string, threadId: string): Promise<ThreadMessage[]> {
    return structuredClone(this.threads.get(`${projectId}/${threadId}`) ?? [])
  }

  async append(projectId: string, threadId: string, message: ThreadMessage): Promise<void> {
    const key = `${projectId}/${threadId}`
    this.threads.set(key, [...(this.threads.get(key) ?? []), structuredClone(message)])
  }
}
