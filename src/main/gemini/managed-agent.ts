import { setTimeout as delay } from 'node:timers/promises'
import type { ManagedAgentResult } from '../../shared/gemini'
import { validateGraph, validateProposal, type FixtureSource } from './contracts.ts'

const verifyCommand = 'cd /workspace/diogenes && node --experimental-strip-types verify-retry.mjs'
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

async function readInteraction(response: Response): Promise<Interaction> {
  if (!response.ok) throw new Error(`Managed agent request failed (HTTP ${response.status}).`)
  return response.json()
}

export function readManagedResult(steps: InteractionStep[]): ManagedAgentResult {
  const verifyCalls = new Set(
    steps
      .filter(
        (step) =>
          step.type === 'code_execution_call' &&
          /\bnode\b[^\r\n]*\bverify-retry\.mjs\b/.test(step.arguments?.code ?? '')
      )
      .map((step) => step.id)
  )
  const output = steps.findLast(
    (step) =>
      step.type === 'code_execution_result' &&
      !!step.call_id &&
      verifyCalls.has(step.call_id) &&
      step.is_error !== true &&
      typeof step.result === 'string'
  )?.result
  const report =
    typeof output === 'string'
      ? output.split(/\r?\n/).find((line) => line.startsWith(resultPrefix))
      : undefined
  if (!report)
    throw new Error(
      'The managed agent did not return output from the fixture verification command.'
    )
  const result: ManagedAgentResult = JSON.parse(report.slice(resultPrefix.length))
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
  return result
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

  const key = process.env.GEMINI_API_KEY?.trim()
  if (!key) throw new Error('GEMINI_API_KEY is missing from the main-process environment.')
  const worker = files.find(({ path }) => path === 'worker.ts')!
  const sources = [
    ...files,
    { path: 'worker.before.ts', text: worker.text },
    { path: 'verify-retry.mjs', text: verification }
  ].map(({ path, text }) => ({
    type: 'inline',
    target: `/workspace/diogenes/${path}`,
    content: text
  }))

  const headers = { 'Api-Revision': '2026-05-20', 'x-goog-api-key': key }
  const response = await fetch(interactionsUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      agent: 'antigravity-preview-09-2026',
      background: true,
      agent_config: { type: 'antigravity', model: 'gemini-4-carbon', max_total_tokens: 24_000 },
      environment: { type: 'remote', sources },
      tools: [{ type: 'code_execution' }],
      input: [
        'Implement the approved diagram change in /workspace/diogenes/worker.ts.',
        `Approved graph change: replace ${edit.replaceTransitionId} with ${expected.join(', ')}.`,
        'Retry a failed job exactly once, then set its final status from the retry result.',
        'Preserve success on the first attempt. Keep all other files as supplied.',
        'Edit worker.ts, then use the shell tool to run the supplied check:',
        verifyCommand,
        'Fix any failed checks and rerun the same command.'
      ].join('\n')
    })
  })
  let interaction = await readInteraction(response)
  const interactionId = interaction.id
  const deadline = Date.now() + 300_000
  while (interaction.status === 'in_progress' || interaction.status === 'queued') {
    if (!interactionId) throw new Error('The managed agent did not return an interaction ID.')
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('The managed agent is still running after five minutes.')

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
  return readManagedResult(interaction.steps ?? [])
}
