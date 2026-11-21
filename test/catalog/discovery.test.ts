import { describe, expect, it } from 'vitest'
import { deriveCatalog } from '../../src/main/catalog/discovery'
import type { CatalogNode } from '../../src/shared/catalog'
import {
  GRAPH_SCHEMA_VERSION,
  type GraphEdge,
  type GraphNode,
  type SoftwareGraph,
  type SourceSpan
} from '../../src/shared/indexing'

const sources: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'app',
    main: 'out/main.js',
    bin: { tool: 'bin/tool.js' },
    devDependencies: { electron: '1' }
  }),
  'src/channels.ts': [
    "export const channels = { ping: 'app:ping' } as const",
    "export const loose = { pong: 'app:pong' }"
  ].join('\n'),
  'src/main.ts': [
    "import { ipcMain as ipc } from 'electron'",
    "import { channels, loose } from './channels'",
    "function ping(): string { return 'pong' }",
    "const prefix = 'app:'",
    "ipc.handle('app:hello', ping)",
    "ipc.handle(channels.ping, () => 'pong')",
    "ipc.handle(loose.pong, () => 'x')",
    "ipc.handle(prefix + 'dyn', () => 'x')"
  ].join('\n'),
  'src/preload.ts': [
    "import * as electron from 'electron'",
    'export const api = {',
    "  hello: () => electron.ipcRenderer.invoke('app:hello'),",
    "  missing: () => electron.ipcRenderer.invoke('app:missing')",
    '}'
  ].join('\n'),
  // Same-named method on an object that is not Electron's.
  'src/fake.ts': [
    'const ipcMain = { handle: (_c: string, _f: unknown) => {} }',
    "ipcMain.handle('fake:channel', () => 1)"
  ].join('\n'),
  'src/server.ts': [
    "import express from 'express'",
    "import { makeRouter } from './other'",
    'const app = express()',
    'const other = makeRouter()',
    'function health(): void {}',
    "app.get('/health', health)",
    "app.post(`/items/${'x'}`, health)",
    "other.get('/not-express', health)"
  ].join('\n'),
  'schemas/item.schema.json': JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Item'
  }),
  'schemas/plain.schema.json': JSON.stringify({ title: 'No dialect' }),
  'compose.yaml': ['services:', '  db:', '    image: postgres:16', '  web:', '    build: .'].join(
    '\n'
  )
}

/** Span of the `nth` occurrence of `needle` in a fixture file. */
function at(path: string, needle: string, nth = 0): SourceSpan {
  const lines = sources[path].split('\n')
  let seen = 0
  for (let line = 0; line < lines.length; line++) {
    for (let c = lines[line].indexOf(needle); c >= 0; c = lines[line].indexOf(needle, c + 1)) {
      if (seen++ === nth)
        return { path, start: { line, character: c }, end: { line, character: c + needle.length } }
    }
  }
  throw new Error(`${needle} not in ${path}`)
}

function node(id: string, kind: GraphNode['kind'], name: string, span: SourceSpan): GraphNode {
  return {
    id,
    kind,
    name,
    path: span.path,
    span,
    extent: span,
    language: 'typescript',
    evidence: []
  }
}

function edge(
  id: string,
  kind: GraphEdge['kind'],
  from: string,
  to: string | null,
  site: SourceSpan,
  role?: GraphEdge['role']
): GraphEdge {
  return {
    id,
    kind,
    role,
    from,
    to,
    resolution: to ? 'resolved' : 'unresolved',
    provenance: ['ts-ast', 'scip'],
    sites: [site]
  }
}

function fixtureGraph(): SoftwareGraph {
  const paths = Object.keys(sources)
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    repository: { id: 7, fullName: 'octo/app' },
    commit: { sha: 'c'.repeat(40), ref: 'main' },
    analyzers: [],
    analyzerConfigKey: 'test',
    positionEncoding: 'utf-16',
    generatedAt: '2026-11-21T00:00:00.000Z',
    status: 'complete',
    files: paths.map((path) => ({
      path,
      status: path.endsWith('.ts') ? 'analyzed' : 'skipped',
      language: path.endsWith('.ts') ? 'typescript' : null,
      bytes: sources[path].length
    })),
    nodes: [
      node('ts:src/main.ts#ping().', 'function', 'ping', at('src/main.ts', 'ping')),
      node('ts:src/server.ts#health().', 'function', 'health', at('src/server.ts', 'health')),
      node('ts:src/channels.ts#ping0:', 'property', 'ping', at('src/channels.ts', 'ping')),
      node('ts:src/channels.ts#pong0:', 'property', 'pong', at('src/channels.ts', 'pong')),
      node('ts:src/preload.ts#api.', 'variable', 'api', at('src/preload.ts', 'api'))
    ],
    edges: [
      edge(
        'e:handler',
        'references',
        'file:src/main.ts',
        'ts:src/main.ts#ping().',
        at('src/main.ts', 'ping', 1),
        'callback-argument'
      ),
      edge(
        'e:const',
        'references',
        'file:src/main.ts',
        'ts:src/channels.ts#ping0:',
        at('src/main.ts', 'ping', 2)
      ),
      edge(
        'e:loose',
        'references',
        'file:src/main.ts',
        'ts:src/channels.ts#pong0:',
        at('src/main.ts', 'pong', 1)
      ),
      edge('e:invoke', 'calls', 'ts:src/preload.ts#api.', null, at('src/preload.ts', 'invoke')),
      edge(
        'e:health',
        'references',
        'file:src/server.ts',
        'ts:src/server.ts#health().',
        at('src/server.ts', 'health', 2),
        'callback-argument'
      )
    ],
    coverage: {
      sourceFiles: 5,
      analyzedFiles: 5,
      skippedFiles: 0,
      rejectedEntries: 0,
      skippedByReason: {},
      unsupportedLanguages: {},
      missingDependencies: [],
      nodes: 5,
      edges: 5,
      edgesByKind: {},
      edgesByResolution: {}
    },
    diagnostics: []
  }
}

const readSource = async (path: string): Promise<string | null> => sources[path] ?? null

describe('catalog discovery', () => {
  it('catalogs explicit IPC, HTTP and declarations, and nothing it cannot prove', async () => {
    const catalog = await deriveCatalog(fixtureGraph(), readSource)
    const byId = new Map(catalog.nodes.map((n) => [n.id, n]))
    const op = (id: string): Extract<CatalogNode, { kind: 'operation' }> =>
      byId.get(id) as Extract<CatalogNode, { kind: 'operation' }>

    expect(catalog).toMatchObject({ revision: 0, commit: { sha: 'c'.repeat(40) } })

    // Literal channel with the handler resolved through the index.
    const hello = op('operation:electron-ipc:.:app:hello')
    expect(hello).toMatchObject({
      resolution: 'bound',
      properties: {
        protocol: 'electron-ipc',
        address: 'app:hello',
        handlerId: 'ts:src/main.ts#ping().'
      }
    })
    expect(hello.sources).toContainEqual({
      path: 'src/main.ts',
      span: {
        path: 'src/main.ts',
        start: { line: 4, character: 0 },
        end: { line: 4, character: 29 }
      },
      field: 'registration'
    })
    expect(catalog.edges).toContainEqual(
      expect.objectContaining({
        kind: 'calls',
        from: { nodeId: 'generic:ts:src/preload.ts#api.', portId: 'out:electron-ipc' },
        to: { nodeId: hello.id, portId: 'in' },
        sources: [expect.objectContaining({ evidenceId: 'e:invoke', field: 'invocation' })]
      })
    )

    // `channels.ping` resolves through an `as const` declaration; the handler is inline, so unknown.
    const ping = op('operation:electron-ipc:.:app:ping')
    expect(ping.resolution).toBe('bound')
    expect(ping.properties.handlerId).toBeUndefined()
    expect(ping.sources).toContainEqual(
      expect.objectContaining({
        path: 'src/channels.ts',
        evidenceId: 'ts:src/channels.ts#ping0:',
        field: 'address'
      })
    )

    // Invoked but never registered: address known, operation unresolved.
    expect(op('operation:electron-ipc:.:app:missing').resolution).toBe('unresolved')

    // Mutable object, computed concatenation and template: explicit unknown addresses.
    const unknown = catalog.nodes.filter(
      (n) => n.kind === 'operation' && n.properties.address === undefined
    )
    expect(unknown.map((n) => [n.resolution, n.sources[0].span?.start.line])).toEqual([
      ['unresolved', 6],
      ['unresolved', 7],
      ['unresolved', 6]
    ])
    expect(byId.has('operation:electron-ipc:.:app:pong')).toBe(false)

    // HTTP route anchored to `express()`; same-named methods elsewhere are ignored.
    expect(op('operation:http:src/server.ts#app:GET /health')).toMatchObject({
      resolution: 'bound',
      properties: {
        protocol: 'http',
        address: 'GET /health',
        handlerId: 'ts:src/server.ts#health().'
      }
    })
    const ids = catalog.nodes.map((n) => n.id).join('\n')
    expect(ids).not.toMatch(/fake|not-express/)

    // Declarations.
    expect(byId.get('module:npm:.')).toMatchObject({
      properties: { packageName: 'app', root: '.' }
    })
    expect(byId.get('workload:npm:.:main')).toMatchObject({
      properties: { role: 'process', entryPoint: 'out/main.js' }
    })
    expect(byId.get('workload:npm:.:bin:tool')).toMatchObject({ properties: { role: 'cli' } })
    expect(byId.get('dataContract:json-schema:schemas/item.schema.json')).toMatchObject({
      name: 'Item',
      properties: { format: 'json-schema', version: '2020-12' }
    })
    expect(byId.has('dataContract:json-schema:schemas/plain.schema.json')).toBe(false)
    expect(byId.get('resource:compose:compose.yaml#db')).toMatchObject({
      properties: { resourceType: 'store', address: 'db' }
    })
    expect(byId.has('resource:compose:compose.yaml#web')).toBe(false)
    expect(catalog.edges.map((e) => e.id)).toContain(
      'contains:module:npm:.->operation:electron-ipc:.:app:hello'
    )

    // Deterministic regardless of input order.
    const shuffled = fixtureGraph()
    shuffled.files.reverse()
    shuffled.edges.reverse()
    expect(await deriveCatalog(shuffled, readSource)).toEqual(catalog)
  })
})
