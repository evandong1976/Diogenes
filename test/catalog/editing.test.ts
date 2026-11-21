import { describe, expect, it } from 'vitest'
import { applyCatalogPatch } from '../../src/main/catalog/editing'
import type { CatalogGraph, CatalogOperation, CatalogPatch } from '../../src/shared/catalog'
import { catalogFixture, refundCall, refundOperation } from '../fixtures/catalog/example'

const patch = (graph: CatalogGraph, ...operations: CatalogOperation[]): CatalogPatch => ({
  repositoryId: graph.repository.id,
  commitSha: graph.commit.sha,
  baseRevision: graph.revision,
  operations
})

const insertAudit: CatalogOperation = {
  type: 'insert',
  edgeId: 'submit-charge',
  node: refundOperation('audit', 'Audit refund'),
  incoming: refundCall('submit-audit', 'submit', 'audit'),
  outgoing: refundCall('audit-charge', 'audit', 'charge')
}

describe('applyCatalogPatch', () => {
  it('inserts a component on exactly the chosen edge, then disconnects and deletes it', () => {
    const graph = catalogFixture()
    const before = structuredClone(graph)

    const inserted = applyCatalogPatch(graph, patch(graph, insertAudit))
    expect(inserted.ok).toBe(true)
    if (!inserted.ok) return
    expect(inserted.graph.revision).toBe(1)
    expect(inserted.graph.edges.map((e) => e.id)).toEqual(['submit-audit', 'audit-charge'])
    expect(graph).toEqual(before)

    const removed = applyCatalogPatch(
      inserted.graph,
      patch(
        inserted.graph,
        { type: 'disconnect', edgeId: 'submit-audit' },
        { type: 'disconnect', edgeId: 'audit-charge' },
        { type: 'delete', nodeId: 'audit' },
        { type: 'connect', edge: refundCall('submit-charge', 'submit', 'charge') }
      )
    )
    expect(removed.ok && removed.graph.nodes.map((n) => n.id)).toEqual([
      'request',
      'submit',
      'charge'
    ])
  })

  it('rejects stale, incompatible and dangling patches without mutating the draft', () => {
    const graph = catalogFixture()
    const before = structuredClone(graph)
    const rpc = refundOperation('audit', 'Audit refund')
    rpc.ports[0].protocol = 'rpc'

    const cases: [CatalogPatch, string, number | undefined][] = [
      [{ ...patch(graph, insertAudit), baseRevision: 3 }, 'stale', undefined],
      [patch(graph, { ...insertAudit, node: rpc }), 'incompatible', 0],
      [
        patch(
          graph,
          { type: 'create', node: refundOperation('audit', 'Audit') },
          { type: 'delete', nodeId: 'charge' }
        ),
        'dangling',
        1
      ]
    ]
    for (const [input, code, operationIndex] of cases) {
      const result = applyCatalogPatch(graph, input)
      expect(result.ok ? null : result.issue).toMatchObject({ code, operationIndex })
    }
    expect(graph).toEqual(before)
  })
})
