import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, it } from 'vitest'
import { createAntigravityProvider } from '../../src/main/coding/antigravity'
import { sha256 } from '../../src/main/coding/candidate'
import { CodingRunGateway } from '../../src/main/coding/gateway'
import { CodingRunStore } from '../../src/main/coding/store'
import type { CodingHandoff, CodingRunView } from '../../src/shared/codingRun'

// Live: DIOGENES_LIVE_SMOKE=1 GEMINI_API_KEY=... pnpm vitest run test/coding/live.smoke.test.ts
const live = process.env.DIOGENES_LIVE_SMOKE === '1' && !!process.env.GEMINI_API_KEY

it.skipIf(!live)(
  'Antigravity: start, reopen, follow up in the same environment, download a candidate',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-live-'))
    const exportScript = readFileSync(
      new URL('../../src/main/coding/export-candidate.mjs', import.meta.url),
      'utf8'
    )
    const gateway = (): CodingRunGateway =>
      new CodingRunGateway({
        store: new CodingRunStore(root),
        provider: createAntigravityProvider({ apiKey: process.env.GEMINI_API_KEY!.trim() }),
        exportScript
      })
    const body = {
      handoffId: 'smoke',
      repository: { id: 1, fullName: 'diogenes/smoke' },
      baseCommit: '0'.repeat(40),
      intent: 'Change maxAttempts in retry.ts from 1 to 3.',
      guarantees: ['Only change the constant.'],
      latitude: [],
      scope: ['retry.ts']
    }
    const handoff: CodingHandoff = { ...body, digest: sha256(JSON.stringify(body)) }
    const wait = async (g: CodingRunGateway, id: string): Promise<CodingRunView> => {
      for (let i = 0; i < 60; i++) {
        const view = await g.status(id)
        if (view.phase !== 'running' && view.phase !== 'starting') return view
        await new Promise((r) => setTimeout(r, 5_000))
      }
      throw new Error('Timed out')
    }

    const first = gateway()
    const run = await first.start({
      handoff,
      files: [{ path: 'retry.ts', content: 'export const maxAttempts = 1\n' }]
    })
    await first.settle(run.runId)
    const turn0 = await wait(first, run.runId)
    console.log('turn 0', JSON.stringify({ ...turn0, activity: turn0.activity.length }))
    expect(turn0.environmentId).toBeTruthy()

    const second = gateway()
    expect((await second.reopen(run.runId)).phase).toBe('idle')
    await second.followUp(run.runId, 'Use 2 instead of 3.')
    await second.settle(run.runId)
    const done = await wait(second, run.runId)
    console.log('turn 1', JSON.stringify({ ...done, activity: done.activity.length }))
    expect(done.environmentId).toBe(turn0.environmentId)
    expect(done.candidate.status).toBe('ready')
  },
  600_000
)
