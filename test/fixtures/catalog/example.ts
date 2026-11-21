import {
  CATALOG_SCHEMA_VERSION,
  type CatalogEdge,
  type CatalogGraph,
  type CatalogNode
} from '../../../src/shared/catalog.ts'

const source = { path: 'src/refunds.ts' }

export function catalogFixture(): CatalogGraph {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    repository: { id: 42, fullName: 'example/refunds' },
    commit: { sha: 'a'.repeat(40), ref: 'main' },
    revision: 0,
    nodes: [
      {
        id: 'request',
        kind: 'dataContract',
        name: 'Refund request',
        resolution: 'declared',
        properties: { format: 'typescript', version: '1' },
        ports: [],
        sources: [source]
      },
      refundOperation('submit', 'Submit refund'),
      refundOperation('charge', 'Request refund')
    ],
    edges: [refundCall('submit-charge', 'submit', 'charge')]
  }
}

export function refundOperation(id: string, name: string): CatalogNode {
  return {
    id,
    kind: 'operation',
    name,
    resolution: 'proposed',
    properties: { protocol: 'local' },
    ports: [
      { id: 'in', direction: 'in', protocol: 'local', contractId: 'request' },
      { id: 'out', direction: 'out', protocol: 'local', contractId: 'request' }
    ],
    sources: []
  }
}

export function refundCall(id: string, from: string, to: string): CatalogEdge {
  return {
    id,
    kind: 'calls',
    from: { nodeId: from, portId: 'out' },
    to: { nodeId: to, portId: 'in' },
    sources: []
  }
}
