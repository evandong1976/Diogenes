import { describe, expect, it } from 'vitest'
import { checksFromEdits, isRetryOnceExample } from '../../src/shared/checks'
import type { ProposedEdit } from '../../src/shared/gemini'
import { exampleEdit, exampleGraph } from '../../src/renderer/src/canvas/logic'

describe('checksFromEdits', () => {
  it('turns the retry-once edit into added, removed and kept checks in diagram terms', () => {
    const checks = checksFromEdits(exampleGraph, [exampleEdit])
    expect(checks.map((c) => c.id)).toEqual([
      'added:running->retrying',
      'added:retrying->succeeded',
      'added:retrying->failed',
      'removed:running->failed',
      'kept:queued->running',
      'kept:running->succeeded'
    ])
    const removed = checks.find((c) => c.kind === 'removed')!
    expect(removed.description).toMatch(/^From Running, it no longer moves straight to Failed when/)
    // Labels come from the graph, including the newly added state.
    expect(checks[0].description).toMatch(/^From Running, when .+, it moves to Retrying\.$/)
  })

  it('checks the final shape of chained edits', () => {
    // Second edit replaces a transition the first one added: only the newest form is checked.
    const second: ProposedEdit = {
      kind: 'edit',
      summary: 'Give up straight away after a retry times out',
      replaceTransitionId: 'retrying->failed',
      addStates: [{ id: 'timed-out', label: 'Timed out' }],
      addTransitions: [
        {
          id: 'retrying->timed-out',
          from: 'retrying',
          to: 'timed-out',
          trigger: 'the retry times out'
        }
      ]
    }
    const ids = checksFromEdits(exampleGraph, [exampleEdit, second]).map((c) => c.id)
    expect(ids).toContain('added:retrying->timed-out')
    expect(ids).not.toContain('added:retrying->failed')
    expect(ids).not.toContain('removed:retrying->failed')
    expect(ids).toContain('removed:running->failed')
  })

  it('recognizes only the example retry-once edit for the fixed fixture checks', () => {
    expect(isRetryOnceExample([exampleEdit])).toBe(true)
    expect(isRetryOnceExample([exampleEdit, exampleEdit])).toBe(false)
    expect(isRetryOnceExample([{ ...exampleEdit, replaceTransitionId: 'queued->running' }])).toBe(
      false
    )
  })
})
