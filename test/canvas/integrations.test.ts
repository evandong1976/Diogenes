import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { create } from 'tar'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  categorize,
  integrationsDiagram,
  packageOf,
  packageUses,
  REPO_OWNER
} from '../../src/renderer/src/canvas/integrations'
import { runIndexJob } from '../../src/main/indexing/job'
import type { CatalogGraph } from '../../src/shared/catalog'
import type { SoftwareGraph } from '../../src/shared/indexing'

describe('package helpers', () => {
  it('reduces specifiers to package names', () => {
    expect(packageOf('stripe')).toBe('stripe')
    expect(packageOf('@clerk/backend/jwt')).toBe('@clerk/backend')
    expect(packageOf('lodash/fp')).toBe('lodash')
    expect(packageOf('./local')).toBeNull()
    expect(packageOf('node:fs')).toBeNull()
  })

  it('sorts packages into integration categories', () => {
    expect(categorize('stripe')).toBe('api')
    expect(categorize('@clerk/backend')).toBe('auth')
    expect(categorize('@prisma/client')).toBe('database')
    expect(categorize('bullmq')).toBe('messaging')
    expect(categorize('react')).toBe('library')
  })
})

describe('Integrations from an indexed repo', () => {
  let tmp: string
  let graph: SoftwareGraph
  let catalog: CatalogGraph

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'diogenes-integrations-'))
    const archive = join(tmp, 'a.tar.gz')
    await create(
      {
        gzip: true,
        file: archive,
        cwd: join(__dirname, '../fixtures/integrations'),
        prefix: 'octo-integrations-aaaaaaa',
        portable: true
      },
      ['package.json', 'tsconfig.json', 'src']
    )
    const res = await runIndexJob({
      archivePath: archive,
      workDir: join(tmp, 'job'),
      outDir: join(tmp, 'out'),
      repository: { id: 7, fullName: 'octo/integrations' },
      commit: { sha: 'c'.repeat(40), ref: 'main' }
    })
    graph = JSON.parse(await readFile(res.graphPath, 'utf8'))
    expect(graph.catalog).toBeDefined()
    catalog = graph.catalog!
  }, 120_000)
  afterAll(() => rm(tmp, { recursive: true, force: true }))

  it('finds each imported package and the module that uses it', () => {
    const uses = packageUses(graph, catalog)
    const names = uses.map((u) => u.name).sort()
    expect(names).toEqual(['@clerk/backend', 'react', 'stripe'])
    const stripe = uses.find((u) => u.name === 'stripe')!
    const [owner, use] = [...stripe.users][0]
    expect(owner).toBe('module:npm:.')
    expect([...use.files]).toEqual(['src/payments.ts'])
    // The import site is kept as a 1-based source reference.
    expect(stripe.sites[0]).toMatchObject({ path: 'src/payments.ts', startLine: 1 })
  })

  it('draws integrations wired to their module and hides general libraries', () => {
    const diagram = integrationsDiagram(catalog, graph)
    const packages = diagram.nodes.filter((n) => n.id.startsWith('package:'))
    expect(packages.map((n) => [n.label, n.kind]).sort()).toEqual([
      ['@clerk/backend', 'Auth'],
      ['stripe', 'External API']
    ])
    expect(diagram.hiddenLibraries).toBe(1)
    const toStripe = diagram.edges.find((e) => e.to === 'package:stripe')!
    expect(toStripe).toMatchObject({ from: 'module:npm:.', type: 'http' })
    expect(toStripe.label).toMatch(/^(calls|imports) ×\d+$/)
    expect(diagram.edges.find((e) => e.to === 'package:@clerk/backend')?.type).toBe('auth')
    // The using module is drawn, and is where the layout starts.
    expect(diagram.nodes.some((n) => n.id === 'module:npm:.' && n.kind === 'Module')).toBe(true)
    expect(diagram.roots).toContain('module:npm:.')
  })

  it('shows libraries when asked', () => {
    const diagram = integrationsDiagram(catalog, graph, { includeLibraries: true })
    expect(diagram.nodes.some((n) => n.id === 'package:react' && n.kind === 'Library')).toBe(true)
    expect(diagram.hiddenLibraries).toBe(0)
  })

  it('attributes files to the repo when there is no package.json module', () => {
    const bare = { ...catalog, nodes: catalog.nodes.filter((n) => n.kind !== 'module') }
    const diagram = integrationsDiagram(bare, graph)
    expect(diagram.edges.some((e) => e.from === REPO_OWNER && e.to === 'package:stripe')).toBe(true)
    expect(diagram.nodes.find((n) => n.id === REPO_OWNER)?.label).toBe('octo/integrations')
  })

  it('falls back to catalog operations alone without an index graph', () => {
    const diagram = integrationsDiagram(catalog, null)
    expect(diagram.nodes.some((n) => n.id.startsWith('package:'))).toBe(false)
  })
})
