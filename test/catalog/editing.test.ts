import { describe, expect, it } from 'vitest'
import { applyCatalogPatch } from '../../src/main/catalog/editing'
import type {
  CatalogGraph,
  CatalogNode,
  CatalogProtocol,
  CatalogOperation,
  CatalogPatch
} from '../../src/shared/catalog'
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
        { type: 'connect', edge: refundCall('submit-charge', 'submit', 'charge') },
        {
          type: 'connect',
          edge: {
            ...refundCall('uses', 'submit', 'request'),
            kind: 'depends_on',
            from: { nodeId: 'submit' },
            to: { nodeId: 'request' }
          }
        }
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
    const over = (id: string, protocol: CatalogProtocol): CatalogNode => {
      const node = refundOperation(id, id)
      node.ports.forEach((p) => (p.protocol = protocol))
      return node
    }
    const retyped: CatalogNode = { ...graph.nodes[0], kind: 'generic', properties: {} }

    const cases: [CatalogPatch, string, number | undefined, string][] = [
      [{ ...patch(graph, insertAudit), baseRevision: 3 }, 'stale', undefined, 'revision'],
      [patch(graph, { ...insertAudit, node: rpc }), 'incompatible', 0, 'Protocol'],
      [
        patch(
          graph,
          { type: 'create', node: refundOperation('audit', 'Audit') },
          { type: 'delete', nodeId: 'charge' }
        ),
        'dangling',
        1,
        'edge submit-charge'
      ],
      [
        patch(
          graph,
          { type: 'create', node: over('page', 'http') },
          { type: 'create', node: over('next', 'http') },
          { type: 'connect', edge: { ...refundCall('nav', 'page', 'next'), kind: 'navigates_to' } }
        ),
        'incompatible',
        2,
        'navigates_to cannot carry http'
      ],
      [
        patch(
          graph,
          { type: 'create', node: over('loader', 'data') },
          { type: 'create', node: over('store', 'data') },
          { type: 'connect', edge: { ...refundCall('read', 'loader', 'store'), kind: 'reads' } }
        ),
        'incompatible',
        2,
        'must target a resource'
      ],
      [patch(graph, { type: 'delete', nodeId: 'request' }), 'dangling', 0, 'Deleting contract'],
      [patch(graph, { type: 'update', node: retyped }), 'dangling', 0, 'Retyping contract']
    ]
    for (const [input, code, operationIndex, reason] of cases) {
      const result = applyCatalogPatch(graph, input)
      expect(result.ok ? null : result.issue).toMatchObject({ code, operationIndex })
      expect(result.ok || result.issue.message).toContain(reason)
    }
    expect(graph).toEqual(before)
  })
})
