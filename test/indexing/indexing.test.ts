import { copyFile, mkdtemp, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { create } from 'tar'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runIndexJob, analyzerConfigKey } from '../../src/main/indexing/job'
import { IndexingService, type SourceHost } from '../../src/main/indexing/service'
import { DEFAULT_LIMITS } from '../../src/main/indexing/snapshot'
import { GraphStore } from '../../src/main/indexing/store'
import type { SoftwareGraph } from '../../src/shared/indexing'

const FIXTURE = join(__dirname, '../fixtures/ts-alias-barrel')
const SHA1 = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const REPO = { id: 42, fullName: 'octo/fixture', defaultBranch: 'main' }

let tmp: string
let archive: string

/** GitHub-shaped tarball: everything under `<owner>-<repo>-<shortsha>/`. */
async function makeArchive(sha: string): Promise<string> {
  const out = join(tmp, `${sha.slice(0, 7)}.tar.gz`)
  const top = `octo-fixture-${sha.slice(0, 7)}`
  await create({ gzip: true, file: out, cwd: FIXTURE, prefix: top, portable: true }, [
    'package.json',
    'tsconfig.json',
    'src',
    'scripts'
  ])
  return out
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'diogenes-test-'))
  archive = await makeArchive(SHA1)
})
afterAll(() => rm(tmp, { recursive: true, force: true }))

describe('indexing pipeline on the alias/barrel fixture', () => {
  let graph: SoftwareGraph

  beforeAll(async () => {
    const workDir = join(tmp, 'job')
    const res = await runIndexJob({
      archivePath: archive,
      workDir,
      outDir: join(tmp, 'out'),
      repository: { id: REPO.id, fullName: REPO.fullName },
      commit: { sha: SHA1, ref: 'main' }
    })
    graph = JSON.parse(await readFile(res.graphPath, 'utf8'))
    expect((await stat(res.scipPath)).size).toBeGreaterThan(0)
    // Source-only: package.json postinstall never ran.
    await expect(stat(join(workDir, 'src', 'LIFECYCLE_RAN'))).rejects.toThrow()
  }, 120_000)

  const fixtureText = async (
    path: string,
    line: number,
    from: number,
    to: number
  ): Promise<string> =>
    (await readFile(join(FIXTURE, path), 'utf8')).split('\n')[line].slice(from, to)

  it('resolves a cross-file call through the alias and barrel to the right same-named function', async () => {
    const call = graph.edges.find(
      (e) => e.kind === 'calls' && e.to === 'ts:src/lib/text.ts#format().'
    )!
    expect(call).toMatchObject({ from: 'ts:src/app.ts#render().', resolution: 'resolved' })
    expect(call.sites[0]).toEqual({
      path: 'src/app.ts',
      start: { line: 7, character: 16 },
      end: { line: 7, character: 22 }
    })
    expect(await fixtureText('src/app.ts', 7, 16, 22)).toBe('format')

    const other = graph.edges.find(
      (e) => e.kind === 'calls' && e.to === 'ts:src/lib/date.ts#format().'
    )!
    expect(other.sites[0].start).toEqual({ line: 8, character: 29 })
    expect(await fixtureText('src/app.ts', 8, 29, 39)).toBe('formatDate')
  })

  it('records a function passed as a callback as a reference at that site', async () => {
    const ref = graph.edges.find((e) => e.role === 'callback-argument')!
    expect(ref).toMatchObject({
      kind: 'references',
      from: 'ts:src/app.ts#render().',
      to: 'ts:src/lib/math.ts#double.',
      resolution: 'resolved'
    })
    expect(ref.sites[0].start).toEqual({ line: 5, character: 28 })
    expect(await fixtureText('src/app.ts', 5, 28, 34)).toBe('double')
  })

  it('keeps unresolved imports, coverage, and commit identity explicit', () => {
    expect(graph.commit.sha).toBe(SHA1)
    expect(graph.coverage.missingDependencies).toEqual(['left-pad'])
    expect(
      graph.edges.some(
        (e) => e.kind === 'calls' && e.target?.reason === 'import-unresolved:left-pad'
      )
    ).toBe(true)
    expect(graph.files.find((f) => f.path === 'scripts/tool.py')).toMatchObject({
      status: 'skipped',
      reason: 'unsupported-language'
    })
    expect(
      graph.edges.some((e) => e.kind === 'implements' && e.to === 'ts:src/lib/math.ts#Shape#')
    ).toBe(true)
    expect(graph.status).toBe('complete')
  })
})

describe('indexing a repo with no TypeScript or JavaScript', () => {
  it('records an empty code index instead of failing, and still reads manifests', async () => {
    const out = join(tmp, 'no-scripts.tar.gz')
    await create(
      {
        gzip: true,
        file: out,
        cwd: join(__dirname, '../fixtures/no-scripts'),
        prefix: 'octo-empty-ccccccc',
        portable: true
      },
      ['README.md', 'package.json', 'docker-compose.yml']
    )
    const res = await runIndexJob({
      archivePath: out,
      workDir: join(tmp, 'job-empty'),
      outDir: join(tmp, 'out-empty'),
      repository: { id: 7, fullName: 'octo/empty' },
      commit: { sha: 'c'.repeat(40), ref: 'main' }
    })
    const graph: SoftwareGraph = JSON.parse(await readFile(res.graphPath, 'utf8'))
    expect(graph.diagnostics.map((d) => d.code)).toContain('no-typescript-sources')
    expect(graph.catalog?.nodes.some((n) => n.kind === 'module')).toBe(true)
    // Compose files are written into the snapshot so discovery can read them.
    expect(graph.catalog?.nodes.find((n) => n.kind === 'resource')?.name).toBe('db')
  }, 60_000)
})

describe('indexing service', () => {
  it('reuses cache, keeps the prior graph when a refresh fails, and reopens from disk', async () => {
    const dataDir = join(tmp, 'data')
    let sha = SHA1
    let failDownload = false
    let downloads = 0
    const host: SourceHost = {
      generation: () => 1,
      onSessionChange: () => () => {},
      getRepo: async (id) => (id === REPO.id ? REPO : null),
      resolveCommit: async () => ({ sha, ref: 'main' }),
      downloadArchive: async (_r, _s, dest) => {
        downloads++
        if (failDownload) throw new Error('network down')
        await copyFile(archive, dest)
      }
    }
    const make = (): IndexingService =>
      new IndexingService({
        host,
        store: new GraphStore(dataDir),
        runner: (input, onStage) => runIndexJob(input, onStage),
        tmpRoot: tmp,
        configKey: analyzerConfigKey(),
        limits: DEFAULT_LIMITS
      })

    const svc = make()
    await svc.start(REPO.id)
    await svc.idle(REPO.id)
    expect((await svc.getStatus(REPO.id)).lastIndexed?.sha).toBe(SHA1)

    await svc.start(REPO.id)
    await svc.idle(REPO.id)
    expect(downloads).toBe(1)
    expect((await svc.getStatus(REPO.id)).lastIndexed?.cached).toBe(true)

    sha = SHA2
    failDownload = true
    await svc.start(REPO.id)
    await svc.idle(REPO.id)
    const failed = await svc.getStatus(REPO.id)
    expect(failed).toMatchObject({ state: 'failed', error: 'network down' })
    expect(failed.lastIndexed?.sha).toBe(SHA1)

    // "Restart": fresh service and store over the same directory.
    const reopened = make()
    expect((await reopened.getStatus(REPO.id)).lastIndexed?.sha).toBe(SHA1)
    expect((await reopened.getGraph(REPO.id))?.commit.sha).toBe(SHA1)
    await expect(reopened.getGraph(7)).rejects.toThrow(/not accessible/)
  }, 180_000)
})
