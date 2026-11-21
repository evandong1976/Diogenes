import { setTimeout as delay } from 'node:timers/promises'
import { checksFromEdits, type AcceptanceCheck } from '../../shared/checks'
import type { CurrentGraph, ManagedAgentResult, ProposedEdit } from '../../shared/gemini'
import { applyEdit } from '../../shared/graph'
import {
  validateGraph,
  validateProposal,
  validateRepoGraph,
  type FixtureSource
} from './contracts.ts'

const resultPrefix = 'DIOGENES_RESULT '
const interactionsUrl = 'https://generativelanguage.googleapis.com/v1beta/interactions'

interface InteractionStep {
  type?: string
  id?: string
  call_id?: string
  arguments?: { code?: string }
  is_error?: boolean
  result?: unknown
}

interface Interaction {
  id?: string
  status?: string
  steps?: InteractionStep[]
}

type InlineSource = { type: 'inline'; target: string; content: string }

async function readInteraction(response: Response): Promise<Interaction> {
  if (!response.ok) throw new Error(`Managed agent request failed (HTTP ${response.status}).`)
  return response.json()
}

/**
 * Starts an Antigravity run in a fresh sandbox holding `sources` and polls until it finishes.
 * Returns its steps; the caller reads the verification output from them.
 */
async function runInteraction(
  sources: InlineSource[],
  input: string,
  { maxTokens, timeoutMs }: { maxTokens: number; timeoutMs: number }
): Promise<InteractionStep[]> {
  const key = process.env.GEMINI_API_KEY?.trim()
  if (!key) throw new Error('GEMINI_API_KEY is missing from the main-process environment.')
  const headers = { 'Api-Revision': '2026-05-20', 'x-goog-api-key': key }
  const response = await fetch(interactionsUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      agent: 'antigravity-preview-09-2026',
      background: true,
      agent_config: { type: 'antigravity', model: 'gemini-4-carbon', max_total_tokens: maxTokens },
      environment: { type: 'remote', sources },
      tools: [{ type: 'code_execution' }],
      input
    })
  })
  let interaction = await readInteraction(response)
  const interactionId = interaction.id
  const deadline = Date.now() + timeoutMs
  while (interaction.status === 'in_progress' || interaction.status === 'queued') {
    if (!interactionId) throw new Error('The managed agent did not return an interaction ID.')
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(
        `The managed agent is still running after ${Math.round(timeoutMs / 60_000)} minutes.`
      )
    }

    await delay(Math.min(remaining, 5_000))
    const current = await fetch(`${interactionsUrl}/${encodeURIComponent(interactionId)}`, {
      headers,
      signal: AbortSignal.timeout(20_000)
    }).catch(() => null)
    if (!current || current.status === 429 || current.status >= 500) continue
    interaction = await readInteraction(current)
  }
  if (interaction.status !== 'completed' && interaction.status !== 'incomplete') {
    throw new Error(`Managed agent run ended with status ${interaction.status ?? 'unknown'}.`)
  }
  // The agent can hit its budget after observing valid verification output.
  return interaction.steps ?? []
}

/**
 * The last successful run of our verification command, read from the sandbox's own output, not
 * from anything the agent says about it.
 */
function readReport(steps: InteractionStep[], command: RegExp): unknown {
  const calls = new Set(
    steps
      .filter(
        (step) => step.type === 'code_execution_call' && command.test(step.arguments?.code ?? '')
      )
      .map((step) => step.id)
  )
  const output = steps.findLast(
    (step) =>
      step.type === 'code_execution_result' &&
      !!step.call_id &&
      calls.has(step.call_id) &&
      step.is_error !== true &&
      typeof step.result === 'string'
  )?.result
  const report =
    typeof output === 'string'
      ? output.split(/\r?\n/).find((line) => line.startsWith(resultPrefix))
      : undefined
  if (!report) {
    throw new Error('The managed agent did not return output from the verification command.')
  }
  return JSON.parse(report.slice(resultPrefix.length))
}

// ---- Bundled retry-once example: fixed checks in fixtures/background-job/verify-retry.mjs ----

const fixtureCommand = /\bnode\b[^\r\n]*\bverify-retry\.mjs\b/
const fixtureVerify = 'cd /workspace/diogenes && node --experimental-strip-types verify-retry.mjs'

export function readManagedResult(steps: InteractionStep[]): ManagedAgentResult {
  const result = readReport(steps, fixtureCommand) as ManagedAgentResult
  if (
    !Array.isArray(result?.tests) ||
    result.tests.length !== 3 ||
    !result.tests.every(
      (test) => typeof test?.name === 'string' && typeof test.passed === 'boolean'
    ) ||
    typeof result.diff !== 'string'
  ) {
    throw new Error('The managed agent returned an invalid fixture verification report.')
  }
  return { ...result, checks: 'fixture' }
}

export async function runManagedRetry(
  files: FixtureSource[],
  verification: string,
  graph: unknown,
  proposal: unknown
): Promise<ManagedAgentResult> {
  const current = validateGraph(graph, files)
  const edit = validateProposal(proposal, current)
  if (
    edit.kind !== 'edit' ||
    edit.replaceTransitionId !== 'running->failed' ||
    edit.addStates.length !== 1 ||
    edit.addTransitions.length !== 3
  ) {
    throw new Error('The managed agent supports the retry-once example. Try Saved proposal.')
  }
  const retry = edit.addStates[0].id
  const expected = [`running->${retry}`, `${retry}->succeeded`, `${retry}->failed`]
  if (!expected.every((id) => edit.addTransitions.some((transition) => transition.id === id))) {
    throw new Error('The managed agent supports the retry-once example. Try Saved proposal.')
  }

  const worker = files.find(({ path }) => path === 'worker.ts')!
  const sources: InlineSource[] = [
    ...files,
    { path: 'worker.before.ts', text: worker.text },
    { path: 'verify-retry.mjs', text: verification }
  ].map(({ path, text }) => ({
    type: 'inline',
    target: `/workspace/diogenes/${path}`,
    content: text
  }))

  const steps = await runInteraction(
    sources,
    [
      'Implement the approved diagram change in /workspace/diogenes/worker.ts.',
      `Approved graph change: replace ${edit.replaceTransitionId} with ${expected.join(', ')}.`,
      'Retry a failed job exactly once, then set its final status from the retry result.',
      'Preserve success on the first attempt. Keep all other files as supplied.',
      'Edit worker.ts, then use the shell tool to run the supplied check:',
      fixtureVerify,
      'Fix any failed checks and rerun the same command.'
    ].join('\n'),
    { maxTokens: 24_000, timeoutMs: 300_000 }
  )
  return readManagedResult(steps)
}

// ---- Any approved change: checks derived from the diagram, our own reporter ----

const reportCommand = /\bnode\b[^\r\n]*\breport\.mjs\b/
const reportRun = 'cd /workspace/diogenes && node report.mjs'

/** Validates the graph and every edit in order; returns the edits as checked. */
function validateChange(
  graph: unknown,
  edits: unknown,
  files: FixtureSource[]
): { base: CurrentGraph; edits: ProposedEdit[] } {
  const base = validateRepoGraph(graph, files, { allowMissingSources: true })
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > 10) {
    throw new Error('Expected between 1 and 10 approved edits.')
  }
  let current = base
  const checked: ProposedEdit[] = []
  for (const value of edits) {
    const edit = validateProposal(value, current)
    if (edit.kind !== 'edit') throw new Error('Only approved edits can be sent to the agent.')
    checked.push(edit)
    current = applyEdit(current, edit)
  }
  return { base, edits: checked }
}

const describeGraph = (graph: CurrentGraph): string =>
  [
    `Initial state: ${graph.initialStateId}`,
    `States: ${graph.states.map((s) => `${s.id} (${s.label})`).join(', ')}`,
    'Transitions:',
    ...graph.transitions.map((t) => `- ${t.id}: ${t.trigger}`)
  ].join('\n')

/** The sandbox contents and instructions for a general run. Pure, so it can be tested. */
export function buildChangeRun(
  base: CurrentGraph,
  edits: ProposedEdit[],
  files: FixtureSource[],
  reporter: string
): { checks: AcceptanceCheck[]; sources: InlineSource[]; input: string } {
  const checks = checksFromEdits(base, edits)
  const after = edits.reduce(applyEdit, base)
  const at = (path: string): string => `/workspace/diogenes/${path}`
  const sources: InlineSource[] = [
    ...files.map((f) => ({
      type: 'inline' as const,
      target: at(`repo/${f.path}`),
      content: f.text
    })),
    ...files.map((f) => ({
      type: 'inline' as const,
      target: at(`original/${f.path}`),
      content: f.text
    })),
    { type: 'inline', target: at('checks.json'), content: JSON.stringify({ checks }, null, 2) },
    { type: 'inline', target: at('report.mjs'), content: reporter }
  ]
  const input = [
    'A developer approved a change on a state-machine diagram of this code. Implement it and',
    'prove it with tests.',
    '',
    'The source files are in /workspace/diogenes/repo. Edit only files there.',
    'Unchanged copies are in /workspace/diogenes/original; never edit those, the diff is taken',
    'against them.',
    `Files: ${files.map((f) => f.path).join(', ')}`,
    '',
    'Diagram before the change:',
    describeGraph(base),
    '',
    'Approved change:',
    ...edits.map((e, i) => `${i + 1}. ${e.summary} (replaces ${e.replaceTransitionId})`),
    '',
    'Diagram after the change:',
    describeGraph(after),
    '',
    'Acceptance checks (also in /workspace/diogenes/checks.json):',
    ...checks.map((c) => `- ${c.id}: ${c.description}`),
    '',
    'Steps:',
    '1. Change the code in repo/ so it behaves like the diagram after the change. Keep',
    '   unrelated behavior.',
    '2. Write repo/diogenes-checks.mjs, a Node script that imports and exercises the real code',
    '   (TypeScript files load with node --experimental-strip-types; stub I/O such as network',
    '   or database calls). For every check ID above, print exactly one JSON line:',
    '   {"id": "<check id>", "passed": true or false, "detail": "<what you observed>"}',
    '   Test behavior, not source text, and never hardcode a result.',
    '3. Run this command with the shell tool:',
    `   ${reportRun}`,
    '4. Fix the code (not the checks) until every check passes, then rerun the same command.'
  ].join('\n')
  return { checks, sources, input }
}

/** Reads our reporter's line, keeping only the checks we asked for, in our wording. */
export function readChangeResult(
  steps: InteractionStep[],
  checks: AcceptanceCheck[]
): ManagedAgentResult {
  const report = readReport(steps, reportCommand) as {
    tests?: { id?: unknown; passed?: unknown; detail?: unknown }[]
    diff?: unknown
    changedFiles?: unknown
  }
  if (
    !Array.isArray(report?.tests) ||
    typeof report.diff !== 'string' ||
    !Array.isArray(report.changedFiles)
  ) {
    throw new Error('The managed agent returned an invalid verification report.')
  }
  const byId = new Map(report.tests.map((t) => [t.id, t]))
  return {
    checks: 'diagram',
    diff: report.diff,
    changedFiles: report.changedFiles.filter((p): p is string => typeof p === 'string'),
    tests: checks.map((check) => {
      const t = byId.get(check.id)
      return {
        id: check.id,
        name: check.description,
        passed: t?.passed === true,
        detail: typeof t?.detail === 'string' ? t.detail : 'Missing from the report.'
      }
    })
  }
}

export async function runManagedChange(
  graph: unknown,
  edits: unknown,
  files: FixtureSource[],
  reporter: string
): Promise<ManagedAgentResult> {
  const change = validateChange(graph, edits, files)
  const run = buildChangeRun(change.base, change.edits, files, reporter)
  const steps = await runInteraction(run.sources, run.input, {
    maxTokens: 80_000,
    timeoutMs: 480_000
  })
  return readChangeResult(steps, run.checks)
}
