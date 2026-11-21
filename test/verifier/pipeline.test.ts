// The general verifier end to end, minus Antigravity: build the sandbox contents, play the
// agent's part (edit the code, write diogenes-checks.mjs, run report.mjs), then read the report
// the way the app does.

import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildChangeRun,
  readChangeResult,
  runManagedChange
} from '../../src/main/gemini/managed-agent'
import { exampleEdit, exampleGraph } from '../../src/renderer/src/canvas/logic'

const fixture = join(__dirname, '../../fixtures/background-job/source')
const reporter = readFileSync(join(__dirname, '../../src/main/gemini/verifier/report.mjs'), 'utf8')
const files = ['job.ts', 'worker.ts'].map((path) => ({
  path,
  text: readFileSync(join(fixture, path), 'utf8')
}))

// What a correct agent would write for the retry-once change.
const retryingWorker = `import type { Job } from './job'

export async function processJob(job: Job): Promise<void> {
  job.status = 'running'
  try {
    await job.run()
    job.status = 'succeeded'
    return
  } catch {
    // Retry once.
  }
  try {
    await job.run()
    job.status = 'succeeded'
  } catch {
    job.status = 'failed'
  }
}
`

// The agent's checks script: exercises the real worker and reports each check ID.
const checksScript = `import { enqueue } from './job.ts'
import { processJob } from './worker.ts'

async function attempt(failures) {
  let runs = 0
  const job = enqueue(async () => {
    runs++
    if (runs <= failures) throw new Error('boom')
  })
  await processJob(job)
  return { runs, status: job.status }
}

const once = await attempt(1)
const twice = await attempt(2)
const ok = await attempt(0)
const report = (id, passed, detail) => console.log(JSON.stringify({ id, passed, detail }))
report('added:running->retrying', once.runs === 2, 'runs after one failure: ' + once.runs)
report('added:retrying->succeeded', once.status === 'succeeded', 'status: ' + once.status)
report('added:retrying->failed', twice.status === 'failed' && twice.runs === 2, JSON.stringify(twice))
report('removed:running->failed', once.status !== 'failed', 'status: ' + once.status)
report('kept:queued->running', true, 'processJob starts the job')
report('kept:running->succeeded', ok.status === 'succeeded' && ok.runs === 1, JSON.stringify(ok))
report('made-up-check', true, 'not one of ours')
`

let dir: string
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

/** Writes the sandbox the way Antigravity would, then lets `agent` edit it. */
function sandbox(agent: (root: string) => void): string {
  dir = mkdtempSync(join(tmpdir(), 'diogenes-sandbox-'))
  const run = buildChangeRun(exampleGraph, [exampleEdit], files, reporter)
  for (const s of run.sources) {
    const path = join(dir, s.target.replace('/workspace/diogenes/', ''))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, s.content)
  }
  agent(dir)
  const out = spawnSync(process.execPath, [join(dir, 'report.mjs')], { encoding: 'utf8' })
  expect(out.status).toBe(0)
  return out.stdout
}

/** The agent run's steps as Antigravity returns them, with our reporter's real output. */
const steps = (stdout: string, code = 'cd /workspace/diogenes && node report.mjs'): object[] => [
  { type: 'code_execution_call', id: 'c1', arguments: { code } },
  { type: 'code_execution_result', call_id: 'c1', result: stdout }
]

describe('general verifier pipeline', () => {
  const run = buildChangeRun(exampleGraph, [exampleEdit], files, reporter)

  it('puts the repo, untouched originals, checks and reporter in the sandbox', () => {
    const targets = run.sources.map((s) => s.target)
    expect(targets).toEqual([
      '/workspace/diogenes/repo/job.ts',
      '/workspace/diogenes/repo/worker.ts',
      '/workspace/diogenes/original/job.ts',
      '/workspace/diogenes/original/worker.ts',
      '/workspace/diogenes/checks.json',
      '/workspace/diogenes/report.mjs'
    ])
    for (const c of run.checks) expect(run.input).toContain(`${c.id}: ${c.description}`)
    expect(run.input).toContain('cd /workspace/diogenes && node report.mjs')
  })

  it('passes every check when the agent implements the change', () => {
    const stdout = sandbox((root) => {
      writeFileSync(join(root, 'repo/worker.ts'), retryingWorker)
      writeFileSync(join(root, 'repo/diogenes-checks.mjs'), checksScript)
    })
    const result = readChangeResult(steps(stdout) as never, run.checks)
    expect(result.tests.map((t) => [t.id, t.passed])).toEqual(run.checks.map((c) => [c.id, true]))
    // Our wording, not the agent's; checks we didn't ask for are dropped.
    expect(result.tests.map((t) => t.name)).toEqual(run.checks.map((c) => c.description))
    expect(result.changedFiles).toEqual(['worker.ts'])
    expect(result.diff).toContain('+    // Retry once.')
    expect(result.checks).toBe('diagram')
  })

  it('fails the retry checks when the code is left unchanged', () => {
    const stdout = sandbox((root) =>
      writeFileSync(join(root, 'repo/diogenes-checks.mjs'), checksScript)
    )
    const result = readChangeResult(steps(stdout) as never, run.checks)
    const passed = Object.fromEntries(result.tests.map((t) => [t.id, t.passed]))
    expect(passed['added:running->retrying']).toBe(false)
    expect(passed['added:retrying->succeeded']).toBe(false)
    expect(passed['kept:running->succeeded']).toBe(true)
    expect(result.changedFiles).toEqual([])
  })

  it('fails every check when the agent never writes a checks script', () => {
    const stdout = sandbox((root) => writeFileSync(join(root, 'repo/worker.ts'), retryingWorker))
    const result = readChangeResult(steps(stdout) as never, run.checks)
    expect(result.tests.every((t) => !t.passed)).toBe(true)
    expect(result.tests[0].detail).toMatch(/was not written/)
  })

  it('counts a check the script skips as failed', () => {
    const stdout = sandbox((root) => {
      writeFileSync(join(root, 'repo/worker.ts'), retryingWorker)
      writeFileSync(
        join(root, 'repo/diogenes-checks.mjs'),
        checksScript.replace(/report\('kept:queued->running'.*\n/, '')
      )
    })
    const kept = readChangeResult(steps(stdout) as never, run.checks).tests.find(
      (t) => t.id === 'kept:queued->running'
    )!
    expect(kept).toMatchObject({ passed: false })
  })

  it('ignores a report the agent printed itself instead of running report.mjs', () => {
    const fake = `DIOGENES_RESULT ${JSON.stringify({ tests: [], diff: '', changedFiles: [] })}`
    expect(() => readChangeResult(steps(fake, 'echo "all good"') as never, run.checks)).toThrow(
      /did not return output from the verification command/
    )
  })

  it('validates the graph and edits before calling the agent', async () => {
    const key = process.env.GEMINI_API_KEY
    delete process.env.GEMINI_API_KEY
    try {
      await expect(runManagedChange(exampleGraph, [], files, reporter)).rejects.toThrow(
        /between 1 and 10 approved edits/
      )
      await expect(
        runManagedChange(
          exampleGraph,
          [{ ...exampleEdit, replaceTransitionId: 'nope' }],
          files,
          reporter
        )
      ).rejects.toThrow(/validation/)
      // Valid input gets as far as needing the API key.
      await expect(runManagedChange(exampleGraph, [exampleEdit], files, reporter)).rejects.toThrow(
        /GEMINI_API_KEY/
      )
    } finally {
      if (key !== undefined) process.env.GEMINI_API_KEY = key
    }
  })
})
