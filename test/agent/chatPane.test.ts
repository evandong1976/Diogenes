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
  renderToStaticMarkup(createElement(ChatPane, { chat: c, selected: null }))

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
  it('shows a quiet working line before the backend records any tool call', () => {
    const html = render(chat(project({ ...running, toolCalls: [], evidence: [] }), [], true))
    expect(html).toContain('Working…')
    expect(html).toContain('chat__pulse')
  })

  it('shows the newest recorded step while running, with every step behind the fold', () => {
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
    expect(html).toContain('Working · Read src/retry.ts:12-40')
    expect(html).toContain('Inspected Refund retry (1 in, 2 out)')
    expect(html).toContain('src/retry.ts')
    expect(html).toContain('12–40')
    // Quiet by default: the trace is collapsed until the reader opens it.
    expect(html).not.toMatch(/<details[^>]*open/)
    // The running turn appears once, as the pending send.
    expect(html.match(/Allow three attempts/g)).toHaveLength(1)
  })

  it('folds a finished trace into one line, and marks a failed one', () => {
    const done = { ...running, status: 'completed' as const, reply: 'Attempt3 is needed.' }
    const finished = render(chat(project(done), [], false))
    expect(finished).toContain('Used 2 tools · 1 source')
    expect(finished).toContain('Attempt3 is needed.')
    expect(finished).not.toContain('Done')

    const failed = {
      ...running,
      status: 'failed' as const,
      error: 'Gemini API 503',
      toolCalls: [{ ...running.toolCalls[0], ok: false, summary: 'Component sm:x not found' }]
    }
    const html = render(chat(project(failed), [], false))
    expect(html).toContain('Failed after 1 tool · 1 source · 1 failed')
    expect(html).toContain('Component sm:x not found')
    expect(html).toContain('Gemini API 503')
  })
})

describe('design chat composer', () => {
  it('swaps Send for Stop while a turn runs, keeping the model visible', () => {
    const html = render(chat(project(running), [], true))
    expect(html).toContain('Stop')
    expect(html).not.toContain('Send <span')
    expect(html).toContain('aria-label="Model for the next turn: gemini-4-carbon"')
  })

  it('opens a new thread quietly, with no suggestions or attachment hint', () => {
    const empty = { ...chat(project(running), [], false), activeId: null } as DesignChat
    const html = render({ ...empty, project: { ...empty.project!, turns: [] } } as DesignChat)
    expect(html).not.toContain('chat__turn')
    expect(html).not.toContain('retry attempt')
    expect(html).not.toContain('chat__context')
    expect(html).toContain('Send <span')
  })
})

describe('design chat proposal', () => {
  it('shows the approved plan with unverified acceptance and a clear send to coding', () => {
    const turn = {
      ...running,
      status: 'awaiting-approval' as const,
      proposalId: 'prop-1',
      reply: 'Proposed.'
    }
    const proposal = {
      id: 'prop-1',
      projectId: '42',
      threadId: 'thr_1',
      turnId: 't1',
      summary: 'Serve notes from Supabase.',
      patch: { repositoryId: 42, commitSha: draft.commitSha, baseRevision: 3, operations: [] },
      preview: {
        baseRevision: 3,
        resultRevision: 4,
        components: [{ id: 'supabase-notes', name: 'Supabase notes', change: 'added' }],
        connections: []
      },
      evidence: [],
      plan: {
        behavior: 'Notes come from the Supabase notes table.',
        steps: ['Add src/supabase.ts'],
        preserved: ['api.notes() keeps its type'],
        acceptance: ['api.notes() returns the same texts'],
        files: ['package.json']
      },
      status: 'approved',
      createdAt: running.startedAt
    }
    const c = {
      ...chat({ ...project(turn), proposals: [proposal] } as ProjectState, [], false),
      handoffs: [],
      codingBusy: null,
      frozen: [{ approvalId: 'a'.repeat(64), correlation: { proposalId: 'prop-1' } }]
    } as unknown as DesignChat
    const html = render(c)
    for (const text of [
      'Intended behavior',
      'Notes come from the Supabase notes table.',
      'Stays true',
      'not verified by Diogenes',
      'package.json',
      'Send to coding agent'
    ])
      expect(html).toContain(text)
  })
})
