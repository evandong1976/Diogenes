import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { create } from 'tar'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildFromGrouping,
  catalogPrompt,
  moduleOf,
  summarizeIndex,
  validateGrouping
} from '../../src/main/gemini/catalog'
import { runIndexJob } from '../../src/main/indexing/job'
import type { GraphEdge, GraphNode, SoftwareGraph } from '../../src/shared/indexing'

describe('moduleOf', () => {
  it('groups by the first meaningful folder', () => {
    expect(moduleOf('src/main/indexing/graph.ts')).toBe('src/main')
    expect(moduleOf('src/app.ts')).toBe('src')
    expect(moduleOf('packages/api/src/index.ts')).toBe('packages/api')
    expect(moduleOf('scripts/tool.py')).toBe('scripts')
    expect(moduleOf('README.md')).toBe('(root)')
  })
})

describe('catalog mapping on the indexed alias/barrel fixture', () => {
  let tmp: string
  let graph: SoftwareGraph

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'diogenes-catalog-'))
    const archive = join(tmp, 'a.tar.gz')
    await create(
      {
        gzip: true,
        file: archive,
        cwd: join(__dirname, '../fixtures/ts-alias-barrel'),
        prefix: 'octo-fixture-aaaaaaa',
        portable: true
      },
      ['package.json', 'tsconfig.json', 'src', 'scripts']
    )
    const res = await runIndexJob({
      archivePath: archive,
      workDir: join(tmp, 'job'),
      outDir: join(tmp, 'out'),
      repository: { id: 1, fullName: 'octo/fixture' },
      commit: { sha: 'a'.repeat(40), ref: 'main' }
    })
    graph = JSON.parse(await readFile(res.graphPath, 'utf8'))
  }, 120_000)
  afterAll(() => rm(tmp, { recursive: true, force: true }))

  it('summarizes folders and counts links from the index', () => {
    const summary = summarizeIndex(graph)
    expect(summary.modules.map((m) => m.key).sort()).toEqual([
      '(root)',
      'scripts',
      'src',
      'src/lib'
    ])
    const app = summary.links.filter((l) => l.from === 'src' && l.to === 'src/lib')
    expect(app.length).toBeGreaterThan(0)
    // Links only ever start in the repo's own code.
    expect(summary.links.every((l) => !l.from.startsWith('pkg:'))).toBe(true)
    expect(() => JSON.parse(catalogPrompt(summary))).not.toThrow()
  })

  it('turns a grouping into levels whose connections come from the index', () => {
    const summary = summarizeIndex(graph)
    const grouping = validateGrouping(
      {
        components: [
          { id: 'cli', type: 'service', label: 'App', detail: 'Entry point', members: ['src'] },
          { id: 'lib', type: 'module', label: 'Library', detail: 'Helpers', members: ['src/lib'] }
        ]
      },
      summary
    )
    const arch = buildFromGrouping(grouping, summary, new Set(graph.files.map((f) => f.path)))
    expect(arch.infrastructure.components.map((c) => c.id)).toEqual(['cli', 'lib'])
    const link = arch.infrastructure.connections.find((c) => c.id === 'cli->lib')
    expect(link?.label).toMatch(/^(imports|calls|references) ×\d+$/)
    expect(arch.infrastructure.components[0].paths).toContain('src/app.ts')
    expect(arch.integrations.components).toEqual([])
  })
})

describe('catalog mapping with external packages', () => {
  const file = (path: string): SoftwareGraph['files'][number] => ({
    path,
    status: 'analyzed',
    language: 'typescript',
    bytes: 10
  })
  const node = (id: string, extra: Partial<GraphNode>): GraphNode => ({
    id,
    kind: 'function',
    name: id,
    evidence: [],
    ...extra
  })
  const edge = (from: string, to: string, kind: GraphEdge['kind']): GraphEdge => ({
    id: `${from}>${to}`,
    kind,
    from,
    to,
    resolution: to.startsWith('ext:') ? 'external' : 'resolved',
    provenance: ['ts-ast'],
    sites: []
  })
  const graph = {
    files: [file('src/api/pay.ts'), file('src/web/app.tsx')],
    nodes: [
      node('ts:src/api/pay.ts#charge', { path: 'src/api/pay.ts' }),
      node('ts:src/web/app.tsx#App', { path: 'src/web/app.tsx' }),
      node('ext:npm:stripe:Stripe', {
        kind: 'external',
        external: { manager: 'npm', package: 'stripe', version: '1' }
      }),
      node('ext:npm:typescript:Promise', {
        kind: 'external',
        external: { manager: 'npm', package: 'typescript', version: '5' }
      })
    ],
    edges: [
      edge('ts:src/web/app.tsx#App', 'ts:src/api/pay.ts#charge', 'calls'),
      edge('ts:src/api/pay.ts#charge', 'ext:npm:stripe:Stripe', 'calls'),
      edge('ts:src/api/pay.ts#charge', 'ext:npm:stripe:Stripe', 'calls'),
      edge('ts:src/api/pay.ts#charge', 'ext:npm:typescript:Promise', 'references')
    ]
  } as unknown as SoftwareGraph
  const summary = summarizeIndex(graph)
  const paths = new Set(graph.files.map((f) => f.path))

  it('collects packages and ignores compiler-only ones', () => {
    expect(summary.packages.map((p) => p.key)).toEqual(['pkg:stripe'])
    expect(summary.packages[0]).toMatchObject({
      usedBy: ['src/api'],
      files: ['src/api/pay.ts'],
      uses: 2
    })
  })

  it('puts packages on Integrations with the components that use them', () => {
    const grouping = validateGrouping(
      {
        components: [
          { id: 'web', type: 'frontend', label: 'Web', detail: 'UI', members: ['src/web'] },
          { id: 'api', type: 'service', label: 'API', detail: 'Payments', members: ['src/api'] },
          {
            id: 'stripe',
            type: 'external-api',
            label: 'Stripe',
            detail: 'Payments',
            members: ['pkg:stripe']
          }
        ]
      },
      summary
    )
    const arch = buildFromGrouping(grouping, summary, paths)
    expect(arch.infrastructure.connections).toEqual([
      { id: 'web->api', from: 'web', to: 'api', label: 'calls ×1' }
    ])
    expect(arch.integrations.components.map((c) => c.id).sort()).toEqual(['api', 'stripe'])
    expect(arch.integrations.connections).toEqual([
      { id: 'api->stripe', from: 'api', to: 'stripe', label: 'calls ×2' }
    ])
    expect(arch.integrations.components.find((c) => c.id === 'stripe')?.paths).toEqual([
      'src/api/pay.ts'
    ])
  })

  it('rejects groupings that invent keys, reuse keys or mix folders with packages', () => {
    const one = (members: string[]): unknown => ({
      components: [{ id: 'x', type: 'service', label: 'X', detail: 'd', members }]
    })
    expect(() => validateGrouping(one(['src/nope']), summary)).toThrow()
    expect(() => validateGrouping(one(['src/api', 'pkg:stripe']), summary)).toThrow()
    expect(() =>
      validateGrouping(
        {
          components: [
            { id: 'a', type: 'service', label: 'A', detail: 'd', members: ['src/api'] },
            { id: 'b', type: 'service', label: 'B', detail: 'd', members: ['src/api'] }
          ]
        },
        summary
      )
    ).toThrow()
    expect(() =>
      validateGrouping(
        {
          components: [
            { id: 'x', type: 'spaceship', label: 'X', detail: 'd', members: ['src/api'] }
          ]
        },
        summary
      )
    ).toThrow()
  })
})
