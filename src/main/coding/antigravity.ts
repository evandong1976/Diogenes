import {
  ProviderError,
  type CreateTurn,
  type ManagedAgentProvider,
  type ProviderInteraction,
  type ProviderStep
} from './provider'

const base = 'https://generativelanguage.googleapis.com/v1beta'
const agent = 'antigravity-preview-09-2026'
const defaultTurnTokenBudget = 180_000

interface RawStep {
  type?: string
  name?: string
  arguments?: { code?: string; AbsolutePath?: string; SearchDirectory?: string }
  result?: unknown
  is_error?: boolean
  text?: string
  content?: { type?: string; text?: string }[]
}

interface RawInteraction {
  id?: string
  status?: string
  environment_id?: string
  steps?: RawStep[]
}

function toStep(step: RawStep): ProviderStep {
  if (step.type === 'function_call') {
    const path = step.arguments?.AbsolutePath ?? step.arguments?.SearchDirectory
    return { type: 'other', text: `${step.name ?? 'Tool'}${path ? ` · ${path}` : ''}` }
  }
  if (step.type === 'function_result') {
    return {
      type: 'other',
      text: `${step.name ?? 'Tool'} ${step.is_error ? 'failed' : 'finished'}`
    }
  }
  if (step.type === 'code_execution_call') {
    return { type: 'command', text: step.arguments?.code ?? '' }
  }
  if (step.type === 'code_execution_result') {
    const text = typeof step.result === 'string' ? step.result : JSON.stringify(step.result ?? '')
    return { type: 'command_output', text, isError: step.is_error === true }
  }
  const text =
    step.text ??
    step.content
      ?.map((c) => c.text)
      .filter(Boolean)
      .join('\n')
  if (text) return { type: 'text', text }
  return { type: 'other', text: step.type ?? 'step' }
}

/**
 * Gemini Managed Agents (Antigravity) over the Interactions and Environments REST APIs.
 * The API key stays in this process; only the staged sources and prompt are sent.
 */
export function createAntigravityProvider(options: {
  apiKey: string
  model?: string
  maxTotalTokens?: number
  fetch?: typeof fetch
}): ManagedAgentProvider {
  const call = options.fetch ?? fetch
  const headers = { 'Api-Revision': '2026-05-20', 'x-goog-api-key': options.apiKey }

  async function request(url: string, init: RequestInit & { timeout: number }): Promise<Response> {
    let response: Response
    try {
      response = await call(url, {
        ...init,
        headers: { ...headers, ...init.headers },
        signal: AbortSignal.timeout(init.timeout)
      })
    } catch (error) {
      // A create that timed out or lost its connection may still have started a run.
      throw new ProviderError('uncertain', `Provider request failed: ${(error as Error).message}`)
    }
    if (response.ok) return response
    const detail = await response.text().catch(() => '')
    const message = `Provider returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ''}`
    if (response.status === 404) throw new ProviderError('gone', message)
    // A 5xx may come after work started. 4xx (including 429) is refused before it starts.
    if (response.status >= 500) throw new ProviderError('uncertain', message)
    throw new ProviderError('rejected', message)
  }

  const interaction = (raw: RawInteraction): ProviderInteraction => {
    if (!raw.id) throw new ProviderError('uncertain', 'The provider returned no interaction ID.')
    return {
      id: raw.id,
      status: raw.status ?? 'unknown',
      environmentId: raw.environment_id,
      steps: (raw.steps ?? []).filter((step) => step.type !== 'thought').map(toStep)
    }
  }

  // The background GET omits steps until completion. Replay the event stream briefly to expose
  // completed tool calls while the run is active, including after an application restart.
  async function liveSteps(id: string): Promise<ProviderStep[]> {
    const steps: ProviderStep[] = []
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1500)
    try {
      const response = await call(`${base}/interactions/${encodeURIComponent(id)}?stream=true`, {
        headers,
        signal: controller.signal
      })
      if (!response.ok || !response.body) return steps
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
        let end: number
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          if (!data || data === '[DONE]') continue
          const event = JSON.parse(data) as { event_type?: string; step?: RawStep }
          if (event.event_type === 'step.start' && event.step && event.step.type !== 'thought') {
            steps.push(toStep(event.step))
            if (steps.length > 150) steps.shift()
          }
        }
      }
    } catch {
      // Polling the interaction remains authoritative if the stream is unavailable.
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
    return steps
  }

  return {
    agent,
    async create(turn: CreateTurn) {
      const environment = turn.sources
        ? {
            type: 'remote',
            sources: turn.sources.map((s) => ({
              type: 'inline',
              target: s.target,
              content: s.content
            }))
          }
        : turn.environmentId
      if (!environment) throw new ProviderError('rejected', 'A follow-up needs an environment ID.')
      const body = {
        agent,
        background: true,
        store: true,
        agent_config: {
          type: 'antigravity',
          model: options.model ?? 'gemini-4-carbon',
          max_total_tokens: options.maxTotalTokens ?? defaultTurnTokenBudget
        },
        environment,
        // Tools are not carried over by previous_interaction_id; send them every turn.
        tools: [{ type: 'code_execution' }],
        ...(turn.previousInteractionId
          ? { previous_interaction_id: turn.previousInteractionId }
          : {}),
        input: turn.input
      }
      const response = await request(`${base}/interactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: 60_000
      })
      return interaction(await response.json())
    },
    async get(id) {
      const response = await request(`${base}/interactions/${encodeURIComponent(id)}`, {
        timeout: 20_000
      })
      const result = interaction(await response.json())
      if (result.status === 'in_progress' || result.status === 'queued') {
        result.steps = await liveSteps(id)
      }
      return result
    },
    async cancel(id) {
      const response = await request(`${base}/interactions/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        timeout: 20_000
      })
      return interaction(await response.json())
    },
    async readFile(environmentId, path) {
      const target = path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')
      const response = await request(
        `${base}/environments/${encodeURIComponent(environmentId)}/files/${target}?alt=media`,
        { timeout: 30_000 }
      )
      return response.text()
    },
    async environmentStatus(environmentId) {
      try {
        const response = await request(
          `${base}/environments/${encodeURIComponent(environmentId)}`,
          { timeout: 20_000 }
        )
        const env = (await response.json()) as { status?: string }
        return env.status === 'expired' ? 'expired' : 'active'
      } catch (error) {
        if (error instanceof ProviderError && error.kind === 'gone') return 'gone'
        throw error
      }
    }
  }
}
