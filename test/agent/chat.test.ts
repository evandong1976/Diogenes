import { describe, expect, it } from 'vitest'
import {
  buildTranscript,
  checkSelection,
  proposalIsBehind,
  turnInput
} from '../../src/renderer/src/agent/chat'
import type { DraftState, Proposal, TurnRecord } from '../../src/shared/design'
import type { ThreadEvent } from '../../src/shared/threads'

const draft = {
  repository: { id: 42, fullName: 'acme/refunds' },
  commitSha: 'a'.repeat(40),
  revision: 3,
  graph: { nodes: [{ id: 'sm:refund', name: 'Refund retry', kind: 'stateMachine' }] },
  history: []
} as unknown as DraftState

const turn = (id: string, extra: Partial<TurnRecord> = {}): TurnRecord => ({
  id,
  projectId: '42',
  threadId: 'thr_1',
  model: 'gemini-4-carbon',
  status: 'completed',
  graph: { repositoryId: 42, commitSha: draft.commitSha, revision: 3 },
  selection: { status: 'none' },
  startedAt: '2026-11-21T10:00:00.000Z',
  toolCalls: [],
  evidence: [],
  ...extra
})

const proposal = {
  id: 'prop_1',
  status: 'pending',
  summary: 'Add Attempt3',
  preview: { baseRevision: 3, resultRevision: 4, components: [], connections: [] }
} as unknown as Proposal

const event = (
  seq: number,
  body: Partial<ThreadEvent> & Pick<ThreadEvent, 'id' | 'type'>
): ThreadEvent => ({ seq, at: `2026-11-21T10:0${seq}:00.000Z`, ...body }) as ThreadEvent

describe('design chat transcript', () => {
  it('joins the developer message, reply, activity and proposal of one turn', () => {
    const events = [
      event(1, { id: 'turn:t1:developer', type: 'user_message', text: 'Allow three attempts' }),
      event(2, { id: 'turn:t1:assistant', type: 'assistant_message', text: 'Proposed Attempt3.' }),
      event(3, { id: 'wf:h:run:r:running', type: 'reference', note: 'Coding run r is running' })
    ]
    const t1 = turn('t1', {
      status: 'awaiting-approval',
      proposalId: 'prop_1',
      toolCalls: [{ name: 'inspect_component', args: {}, ok: true, summary: 'Read Refund retry' }]
    })
    const items = buildTranscript(events, { turns: [t1], proposals: [proposal] }, 'thr_1')

    expect(items).toHaveLength(2)
    const [first, note] = items
    expect(first).toMatchObject({
      kind: 'turn',
      text: 'Allow three attempts',
      reply: 'Proposed Attempt3.',
      proposal: { id: 'prop_1' }
    })
    expect(first.kind === 'turn' && first.turn?.toolCalls).toHaveLength(1)
    expect(note).toMatchObject({ kind: 'note', text: 'Coding run r is running' })
  })

  it('keeps a stale-graph turn that never reached history, with the text sent from here', () => {
    const stale = turn('t2', { status: 'stale-graph', error: 'reload it and resend' })
    const other = turn('t9', { threadId: 'thr_other' })
    const items = buildTranscript([], { turns: [stale, other], proposals: [] }, 'thr_1', {
      t2: 'Rename the queue'
    })
    expect(items).toEqual([
      expect.objectContaining({ key: 't2', text: 'Rename the queue', turn: stale })
    ])
  })
})

describe('design chat send', () => {
  it('attaches the canvas selection only when it exists in the draft', () => {
    const ok = checkSelection(draft, { componentId: 'sm:refund', label: 'Refund retry' })
    expect(ok).toEqual({
      status: 'ok',
      componentId: 'sm:refund',
      name: 'Refund retry',
      kind: 'stateMachine'
    })
    const input = turnInput({
      projectId: '42',
      threadId: 'thr_1',
      model: 'gemini-4-hydrogen',
      draft,
      message: '  Allow three attempts  ',
      selection: ok
    })
    expect(input).toEqual({
      projectId: '42',
      threadId: 'thr_1',
      model: 'gemini-4-hydrogen',
      graph: { repositoryId: 42, commitSha: draft.commitSha, revision: 3 },
      message: 'Allow three attempts',
      selectedComponentId: 'sm:refund'
    })

    const missing = checkSelection(draft, { componentId: 'draft-x', label: 'New service' })
    expect(missing.status).toBe('missing')
    expect(turnInput({ ...input, draft, selection: missing })).not.toHaveProperty(
      'selectedComponentId'
    )
    expect(checkSelection(draft, null)).toEqual({ status: 'none' })
  })

  it('flags a pending proposal checked against an older draft revision', () => {
    expect(proposalIsBehind(proposal, draft)).toBe(false)
    expect(proposalIsBehind(proposal, { ...draft, revision: 4 })).toBe(true)
    expect(proposalIsBehind({ ...proposal, status: 'approved' }, { ...draft, revision: 4 })).toBe(
      false
    )
  })
})
