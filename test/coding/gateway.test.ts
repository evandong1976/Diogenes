import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { sha256 } from '../../src/main/coding/candidate'
import { CodingRunGateway } from '../../src/main/coding/gateway'
import { CodingRunStore } from '../../src/main/coding/store'
import type { CodingHandoff, CodingRunView } from '../../src/shared/codingRun'
import { FakeProvider, FakeServer, type AgentTurn } from './fakeProvider'

const exportScript = readFileSync(
  new URL('../../src/main/coding/export-candidate.mjs', import.meta.url),
  'utf8'
)
const before = 'export const maxAttempts = 1\n'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** A repository with one commit: the pinned base. */
function baseRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'coding-base-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@example.invalid')
  git(dir, 'config', 'user.name', 'Test')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/retry.ts'), before)
  writeFileSync(join(dir, 'README.md'), 'out of scope\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  return { dir, sha: git(dir, 'rev-parse', 'HEAD') }
}

function handoffFor(sha: string): CodingHandoff {
  const body = {
    handoffId: 'handoff-refund-retry',
    repository: { id: 1, fullName: 'example/refunds' },
    baseCommit: sha,
    intent: 'Retry a failed refund before marking it failed.',
    guarantees: ['A successful first attempt is not retried.'],
    latitude: ['Name the constant as you see fit.'],
    scope: ['src/retry.ts'],
    context: { componentId: 'state-machine:refund-retry' }
  }
  return { ...body, digest: sha256(JSON.stringify(body)) }
}

function setup(agent: AgentTurn[]): {
  server: FakeServer
  root: string
  gateway: () => CodingRunGateway
  base: { dir: string; sha: string }
  handoff: CodingHandoff
} {
  const server = new FakeServer(agent)
  const root = mkdtempSync(join(tmpdir(), 'coding-runs-'))
  const base = baseRepo()
  return {
    server,
    root,
    base,
    handoff: handoffFor(base.sha),
    // A fresh store, provider client and gateway, as after an app restart.
    gateway: () =>
      new CodingRunGateway({
        store: new CodingRunStore(root),
        provider: new FakeProvider(server),
        exportScript
      })
  }
}

const startInput = (handoff: CodingHandoff): Parameters<CodingRunGateway['start']>[0] => ({
  handoff,
  files: [{ path: 'src/retry.ts', content: before }]
})

describe('CodingRunGateway', () => {
  it('starts, reopens from disk, directs the same workspace, and returns a candidate', async () => {
    const { server, base, handoff, gateway } = setup([
      ({ repo, exportCandidate }) => {
        writeFileSync(join(repo, 'src/retry.ts'), 'export const maxAttempts = 3\n')
        exportCandidate()
      },
      ({ repo, input, exportCandidate }) => {
        // Same workspace: the first turn's edit is still on disk.
        expect(readFileSync(join(repo, 'src/retry.ts'), 'utf8')).toContain('= 3')
        expect(input).toContain('Use two attempts')
        writeFileSync(join(repo, 'src/retry.ts'), 'export const maxAttempts = 2\n')
        exportCandidate()
      }
    ])

    // Start: the run ID exists and is persisted before the provider answers.
    const first = gateway()
    const started = await first.start(startInput(handoff))
    expect(started).toMatchObject({ phase: 'starting', handoffDigest: handoff.digest })
    await first.settle(started.runId)
    const turn0 = await first.status(started.runId)
    expect(turn0.phase).toBe('idle')
    expect(turn0.candidate.status).toBe('ready')
    expect(server.requests[0].sources!.map((s) => s.target)).not.toContain(
      '/workspace/repo/README.md'
    )

    // Restart: a new gateway reopens the run purely from persisted references.
    const second = gateway()
    const reopened = await second.reopen(started.runId)
    expect(reopened).toMatchObject({ phase: 'idle', environmentId: turn0.environmentId })
    expect(await second.list()).toMatchObject([{ runId: started.runId, candidate: 'ready' }])

    // Follow-up: continues the conversation in the same environment, without restaging.
    await second.followUp(started.runId, 'Use two attempts, not three.')
    await second.settle(started.runId)
    expect(server.requests[1]).toMatchObject({
      previousInteractionId: turn0.turns[0].interactionId,
      environmentId: turn0.environmentId
    })
    expect(server.requests[1].sources).toBeUndefined()
    const done: CodingRunView = await second.status(started.runId)
    expect(done.phase).toBe('idle')
    expect(server.environments.size).toBe(1)
    if (done.candidate.status !== 'ready') throw new Error(JSON.stringify(done.candidate))
    const { candidate } = done.candidate
    expect(candidate).toMatchObject({
      runId: started.runId,
      handoffId: handoff.handoffId,
      handoffDigest: handoff.digest,
      baseCommit: base.sha,
      files: ['src/retry.ts'],
      provenance: { turn: 1, interactionId: done.turns[1].interactionId }
    })
    expect(sha256(candidate.patch)).toBe(candidate.patchSha256)

    // The candidate materializes on a clean checkout of the base commit.
    git(base.dir, 'checkout', '-q', '--detach', candidate.baseCommit)
    execFileSync('git', ['apply', '--index', '-'], { cwd: base.dir, input: candidate.patch })
    expect(readFileSync(join(base.dir, 'src/retry.ts'), 'utf8')).toBe(
      'export const maxAttempts = 2\n'
    )
  })

  it('makes retries explicit and separates missing artifacts from expired workspaces', async () => {
    const { server, handoff, gateway } = setup([() => {}, () => {}])
    server.dropNextResponse = true

    const g = gateway()
    const run = await g.start(startInput(handoff))
    await g.settle(run.runId)
    // The request reached the provider but the reply was lost: no silent second launch.
    expect(await g.status(run.runId)).toMatchObject({ phase: 'uncertain' })
    expect(server.interactions.size).toBe(1)

    await g.retry(run.runId)
    await g.settle(run.runId)
    const retried = await g.status(run.runId)
    expect(server.interactions.size).toBe(2)
    expect(retried.turns[0].attempts).toHaveLength(2)
    // The agent never exported, but the workspace is alive.
    expect(retried).toMatchObject({ phase: 'idle', candidate: { status: 'missing' } })

    server.environments.get(retried.environmentId!)!.expired = true
    expect(await gateway().reopen(run.runId)).toMatchObject({ phase: 'expired' })
    await expect(g.followUp(run.runId, 'Try again.')).rejects.toThrow(/expired/)
  })

  it('rechecks an unconfirmed cancellation when the provider later stops', async () => {
    const { server, handoff, gateway } = setup([() => {}])
    server.cancel = () => {
      throw new Error('Provider refused cancellation')
    }
    server.get = (id) => {
      const item = server.interactions.get(id)!
      return {
        id: item.id,
        environmentId: item.environmentId,
        status: item.status,
        steps: item.steps
      }
    }
    const g = gateway()
    const run = await g.start(startInput(handoff))
    await g.settle(run.runId)
    const stopped = await g.cancel(run.runId)
    expect(stopped.cancellation?.outcome).toBe('unconfirmed')
    const interaction = server.interactions.get(stopped.turns[0].interactionId!)!
    interaction.status = 'cancelled'
    expect((await g.status(run.runId)).cancellation?.outcome).toBe('confirmed')
  })
})
