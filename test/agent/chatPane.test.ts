import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatPane } from '../../src/renderer/src/agent/ChatPane'
import type { DesignChat } from '../../src/renderer/src/agent/useDesignChat'
import type { DraftState, ProjectState, TurnRecord } from '../../src/shared/design'
import type { ThreadEvent } from '../../src/shared/threads'

const draft = {
  repository: { id: 42, fullName: 'acme/refunds' },
  commitSha: 'a'.repeat(40),
  revision: 3,
  graph: { nodes: [{ id: 'sm:refund', name: 'Refund retry', kind: 'stateMachine' }] },
  history: []
} as unknown as DraftState

const running: TurnRecord = {
  id: 't1',
  projectId: '42',
  threadId: 'thr_1',
  model: 'gemini-4-carbon',
  status: 'running',
  graph: { repositoryId: 42, commitSha: draft.commitSha, revision: 3 },
  selection: {
    status: 'resolved',
    componentId: 'sm:refund',
    name: 'Refund retry',
    kind: 'stateMachine'
  },
  startedAt: '2026-11-21T10:00:00.000Z',
  toolCalls: [
    {
      name: 'inspect_component',
      args: { id: 'sm:refund' },
      ok: true,
      summary: 'Inspected Refund retry (1 in, 2 out)'
    },
    {
      name: 'read_source',
      args: { path: 'src/retry.ts' },
      ok: true,
      summary: 'Read src/retry.ts:12-40'
    }
  ],
  evidence: [
    {
      id: 'ev1',
      entityId: 'sm:refund',
      commitSha: draft.commitSha,
      path: 'src/retry.ts',
      startLine: 11,
      endLine: 40,
      excerpt: '…'
    }
  ]
}

const chat = (project: ProjectState, events: ThreadEvent[], pending: boolean): DesignChat =>
  ({
    load: { status: 'ready' },
    project,
    draft,
    threads: [{ id: 'thr_1', title: 'Design · Nov 21', kind: 'design', lastSeq: events.length }],
    activeId: 'thr_1',
    events,
    pending: pending
      ? {
          threadId: 'thr_1',
          text: 'Allow three attempts',
          model: 'gemini-4-carbon',
          selection: { status: 'none' }
        }
      : null,
    sent: {},
    error: null,
    approvals: {},
    frozen: [],
    deciding: null
  }) as unknown as DesignChat

const render = (c: DesignChat): string =>
  renderToStaticMarkup(createElement(ChatPane, { chat: c, selected: null, onClose: () => {} }))

const project = (turn: TurnRecord): ProjectState =>
  ({
    projectId: '42',
    draft,
    proposals: [],
    intents: [],
    corrections: [],
    turns: [turn]
  }) as ProjectState

describe('design chat activity trace', () => {
  it('shows a working state before the backend records any tool call', () => {
    const html = render(chat(project({ ...running, toolCalls: [], evidence: [] }), [], true))
    expect(html).toContain('Working · no tool calls yet')
    expect(html).toContain('Waiting for the first tool call…')
  })

  it('shows the running turn’s recorded tool calls and sources before the reply', () => {
    const events = [
      {
        id: 'turn:t1:developer',
        seq: 1,
        at: running.startedAt,
        type: 'user_message',
        text: 'Allow three attempts'
      } as ThreadEvent
    ]
    const html = render(chat(project(running), events, true))
    expect(html).toContain('Working · 2 tool calls · 1 source')
    expect(html).toContain('Inspected Refund retry (1 in, 2 out)')
    expect(html).toContain('Read src/retry.ts:12-40')
    expect(html).toContain('src/retry.ts')
    expect(html).toContain('12–40')
    expect(html).toContain('Waiting for the next step…')
    expect(html).toMatch(/<details[^>]*open/)
    // The running turn appears once, as the pending send, with no reply yet.
    expect(html.match(/Allow three attempts/g)).toHaveLength(1)
    expect(html).toContain('The reply appears when the turn finishes.')
  })

  it('keeps the trace collapsed after the turn, and marks a failed one', () => {
    const done = { ...running, status: 'completed' as const, reply: 'Attempt3 is needed.' }
    const finished = render(chat(project(done), [], false))
    expect(finished).toContain('2 tool calls · 1 source')
    expect(finished).not.toMatch(/<details[^>]*open/)
    expect(finished).toContain('Attempt3 is needed.')

    const failed = {
      ...running,
      status: 'failed' as const,
      error: 'Gemini API 503',
      toolCalls: [{ ...running.toolCalls[0], ok: false, summary: 'Component sm:x not found' }]
    }
    const html = render(chat(project(failed), [], false))
    expect(html).toContain('Failed after 1 tool call · 1 source · 1 failed')
    expect(html).toContain('Component sm:x not found')
    expect(html).toContain('Gemini API 503')
  })
})
