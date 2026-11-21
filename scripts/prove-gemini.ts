import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import type { ProposalResult } from '../src/shared/gemini'
import { validateGraph, validateProposal } from '../src/main/gemini/contracts.ts'
import { createGeminiService } from '../src/main/gemini/service.ts'

const fixture = new URL('../fixtures/background-job/', import.meta.url)
const files = await Promise.all(
  ['job.ts', 'worker.ts'].map(async (path) => ({
    path,
    text: await readFile(new URL(`source/${path}`, fixture), 'utf8')
  }))
)

function assertRetryOnce(result: ProposalResult): void {
  assert.equal(result.kind, 'edit', 'The marked arrow should produce an edit.')
  assert.equal(result.replaceTransitionId, 'running->failed')
  assert.equal(result.addStates.length, 1, 'The preview should show one retry state.')
  const retry = result.addStates[0].id
  assert.deepEqual(
    result.addTransitions.map(({ id }) => id).sort(),
    [`running->${retry}`, `${retry}->succeeded`, `${retry}->failed`].sort(),
    'The retry must have exactly two outcomes and no additional retry.'
  )
}

const example = JSON.parse(await readFile(new URL('example.json', fixture), 'utf8'))
const baseline = validateGraph(example.currentGraph, files)
assertRetryOnce(validateProposal(example.proposedEdit, baseline))
assert.equal(validateProposal(example.clarification, baseline).kind, 'clarification')
assert.throws(() => validateGraph({ ...baseline, initialStateId: 'running' }, files))
assert.throws(() =>
  validateProposal({ ...example.proposedEdit, replaceTransitionId: 'queued->failed' }, baseline)
)
assert.throws(() => validateProposal({ ...example.clarification, addStates: [] }, baseline))

if (process.argv.includes('--check-example')) {
  console.log('Fixture example and invalid-response checks passed.')
} else {
  const service = createGeminiService(files)
  let currentGraph = baseline
  try {
    currentGraph = await service.buildCurrentGraph()
    console.log(JSON.stringify({ currentGraph }, null, 2))
  } catch (error) {
    console.error(
      `${error instanceof Error ? error.message : 'Hydrogen failed.'} Using the validated example graph to check Carbon independently.`
    )
    process.exitCode = 1
  }

  try {
    const png = await readFile(new URL('retry-once.png', fixture))
    const proposedEdit = await service.proposeEdit(currentGraph, png)
    assertRetryOnce(proposedEdit)
    const ambiguous = await readFile(new URL('ambiguous.png', fixture))
    const clarification = await service.proposeEdit(currentGraph, ambiguous)
    assert.equal(
      clarification.kind,
      'clarification',
      'The unmarked target should yield a question.'
    )
    console.log(JSON.stringify({ proposedEdit, clarification }, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Carbon failed.')
    process.exitCode = 1
  }
}
