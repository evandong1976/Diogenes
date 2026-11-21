import { describe, expect, it } from 'vitest'
import type { CatalogNode } from '../../src/shared/catalog'
import {
  catalogDiagram,
  catalogKindsByLevel,
  catalogStateMachines,
  stateGraphFromCatalog
} from '../../src/renderer/src/canvas/diagrams'
import { catalogFixture, refundCall } from '../fixtures/catalog/example'

describe('catalogDiagram', () => {
  it('draws a level from catalog nodes and their edges, typed by the source port', () => {
    const catalog = catalogFixture()
    const diagram = catalogDiagram(catalog, catalogKindsByLevel.integrations)
    expect(diagram.nodes.map((n) => n.id).sort()).toEqual(['charge', 'submit'])
    // Proposed catalog nodes draw in the proposed state.
    expect(diagram.nodes.every((n) => n.change === 'added' && n.kind === 'Operation')).toBe(true)
    // A `local` port is a data connection in the design system.
    expect(diagram.edges).toMatchObject([
      { id: 'submit-charge', from: 'submit', to: 'charge', label: 'calls', type: 'data' }
    ])
    expect(diagram.roots).toEqual(['submit'])
  })

  it('leaves out nodes from other levels and edges that leave the level', () => {
    const catalog = catalogFixture()
    catalog.edges.push(refundCall('to-request', 'charge', 'request'))
    const diagram = catalogDiagram(catalog, catalogKindsByLevel.integrations)
    expect(diagram.nodes.some((n) => n.id === 'request')).toBe(false)
    expect(diagram.edges.map((e) => e.id)).toEqual(['submit-charge'])
  })

  it('skips contains edges and falls back to the edge kind without ports', () => {
    const catalog = catalogFixture()
    catalog.edges = [
      {
        id: 'c',
        kind: 'contains',
        from: { nodeId: 'submit' },
        to: { nodeId: 'charge' },
        sources: []
      },
      {
        id: 'p',
        kind: 'publishes_to',
        from: { nodeId: 'submit' },
        to: { nodeId: 'charge' },
        sources: []
      }
    ]
    const diagram = catalogDiagram(catalog, catalogKindsByLevel.integrations)
    expect(diagram.edges).toMatchObject([{ id: 'p', label: 'publishes to', type: 'event' }])
  })
})

describe('stateGraphFromCatalog', () => {
  const machine = (
    transitions: { from: string; to: string; event: string; guard?: string }[]
  ): CatalogNode =>
    ({
      id: 'refund-machine',
      kind: 'stateMachine',
      name: 'Refund',
      resolution: 'bound',
      properties: {
        initialState: 'Pending',
        states: ['Pending', 'Retrying', 'Refunded', 'Failed'],
        transitions
      },
      ports: [],
      sources: [
        {
          path: 'src/refund.ts',
          span: {
            path: 'src/refund.ts',
            start: { line: 4, character: 0 },
            end: { line: 9, character: 1 }
          }
        }
      ]
    }) as CatalogNode

  it('only lists machines with at least two states', () => {
    const catalog = catalogFixture()
    const small = { ...machine([]), id: 'tiny' } as CatalogNode
    if (small.kind === 'stateMachine') small.properties = { states: ['Only'] }
    catalog.nodes.push(machine([]), small)
    expect(catalogStateMachines(catalog).map((m) => m.id)).toEqual(['refund-machine'])
    expect(catalogStateMachines(null)).toEqual([])
  })

  it('builds a valid canvas graph with merged parallel transitions', () => {
    const m = machine([
      { from: 'Pending', to: 'Refunded', event: 'succeeded' },
      { from: 'Pending', to: 'Retrying', event: 'failed', guard: 'attempts < 2' },
      { from: 'Retrying', to: 'Refunded', event: 'succeeded' },
      { from: 'Retrying', to: 'Failed', event: 'failed' },
      { from: 'Retrying', to: 'Failed', event: 'timeout' },
      { from: 'Ghost', to: 'Failed', event: 'ignored' }
    ])
    const graph = stateGraphFromCatalog(m as Extract<CatalogNode, { kind: 'stateMachine' }>)
    expect(graph.initialStateId).toBe('pending')
    expect(graph.states.map((s) => s.id)).toEqual(['pending', 'retrying', 'refunded', 'failed'])
    // The machine's source span (0-based) becomes 1-based lines on the initial state.
    expect(graph.states[0].sources).toEqual([{ path: 'src/refund.ts', startLine: 5, endLine: 10 }])
    expect(graph.transitions.map((t) => [t.id, t.trigger])).toEqual([
      ['pending->refunded', 'succeeded'],
      ['pending->retrying', 'failed [attempts < 2]'],
      ['retrying->refunded', 'succeeded'],
      ['retrying->failed', 'failed / timeout']
    ])
    // Transition IDs follow the from->to rule the proposal validator enforces.
    expect(graph.transitions.every((t) => t.id === `${t.from}->${t.to}`)).toBe(true)
  })
})
