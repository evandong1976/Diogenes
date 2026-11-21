import { describe, expect, it } from 'vitest'
import { initialLogic, shouldAutoBuild } from '../../src/renderer/src/canvas/logic'

describe('shouldAutoBuild', () => {
  it('builds the repo once indexing settles, whether it finished or failed', () => {
    expect(shouldAutoBuild(1, initialLogic, 'complete')).toBe(true)
    expect(shouldAutoBuild(1, initialLogic, 'partial')).toBe(true)
    expect(shouldAutoBuild(1, initialLogic, 'failed')).toBe(true)
  })

  it('waits while indexing runs or before its status is known', () => {
    expect(shouldAutoBuild(1, initialLogic, 'running')).toBe(false)
    expect(shouldAutoBuild(1, initialLogic, undefined)).toBe(false)
  })

  it('never runs without a repo, or twice for the same repo', () => {
    expect(shouldAutoBuild(undefined, initialLogic, 'complete')).toBe(false)
    expect(shouldAutoBuild(1, { ...initialLogic, autoBuiltFor: 1 }, 'complete')).toBe(false)
    expect(shouldAutoBuild(2, { ...initialLogic, autoBuiltFor: 1 }, 'complete')).toBe(true)
  })

  it('leaves anything the user loaded or edited alone', () => {
    expect(
      shouldAutoBuild(1, { ...initialLogic, source: `${initialLogic.source} · edited` }, 'complete')
    ).toBe(false)
    expect(
      shouldAutoBuild(
        1,
        { ...initialLogic, isExample: false, source: 'Index · Refund' },
        'complete'
      )
    ).toBe(false)
  })
})
