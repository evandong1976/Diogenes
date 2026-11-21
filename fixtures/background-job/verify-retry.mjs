import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { enqueue } from './job.ts'
import { processJob } from './worker.ts'

const scenarios = [
  { name: 'Succeeds on the first attempt', failures: 0, attempts: 1, status: 'succeeded' },
  { name: 'Succeeds on the retry', failures: 1, attempts: 2, status: 'succeeded' },
  { name: 'Stops after the retry fails', failures: 2, attempts: 2, status: 'failed' }
]

const tests = []
for (const scenario of scenarios) {
  let attempts = 0
  const job = enqueue(async () => {
    attempts++
    if (attempts <= scenario.failures) throw new Error('Fixture failure')
  })
  let passed = false
  try {
    await processJob(job)
    assert.equal(attempts, scenario.attempts)
    assert.equal(job.status, scenario.status)
    passed = true
  } catch {
    // Keep running so the report includes all cases.
  }
  tests.push({ name: scenario.name, passed })
}

const diff = spawnSync(
  'git',
  ['diff', '--no-index', '--no-ext-diff', '--', 'worker.before.ts', 'worker.ts'],
  {
    cwd: new URL('.', import.meta.url),
    encoding: 'utf8'
  }
)
if (diff.status !== 0 && diff.status !== 1)
  throw new Error(diff.stderr || 'Could not generate the diff.')
console.log('DIOGENES_RESULT ' + JSON.stringify({ tests, diff: diff.stdout }))
