import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  ProviderError,
  type CreateTurn,
  type ManagedAgentProvider,
  type ProviderInteraction,
  type ProviderStep
} from '../../src/main/coding/provider'

/** What the scripted agent does in one turn. `repo` is the workspace's repo directory. */
export type AgentTurn = (ctx: { repo: string; input: string; exportCandidate(): void }) => void

interface Interaction {
  id: string
  environmentId: string
  status: string
  input: string
  steps: ProviderStep[]
}

/**
 * Provider-side state that survives a Diogenes restart: interactions and environments (each a
 * real directory standing in for `/workspace`). Follows the documented rules this gateway relies
 * on: one environment ID per workspace, 400 when chaining onto an in-progress interaction, 404
 * for unknown IDs, and tools that run in the same filesystem across turns.
 */
export class FakeServer {
  readonly requests: CreateTurn[] = []
  readonly interactions = new Map<string, Interaction>()
  readonly environments = new Map<string, { root: string; expired: boolean }>()
  /** Accept the next create, then fail the response as if the connection dropped. */
  dropNextResponse = false
  private seq = 0

  constructor(private readonly agent: AgentTurn[]) {}

  create(turn: CreateTurn): ProviderInteraction {
    this.requests.push(structuredClone(turn))
    let environmentId: string
    if (turn.sources) {
      environmentId = `env_${++this.seq}`
      const root = mkdtempSync(join(tmpdir(), 'fake-env-'))
      for (const s of turn.sources)
        write(join(root, s.target.replace(/^\/workspace\//, '')), s.content)
      mkdirSync(join(root, 'repo'), { recursive: true })
      this.environments.set(environmentId, { root, expired: false })
    } else {
      const env = turn.environmentId && this.environments.get(turn.environmentId)
      if (!env || env.expired) throw new ProviderError('gone', 'HTTP 404: environment not found')
      environmentId = turn.environmentId!
    }
    if (turn.previousInteractionId) {
      const previous = this.interactions.get(turn.previousInteractionId)
      if (!previous) throw new ProviderError('gone', 'HTTP 404: interaction not found')
      if (previous.status === 'in_progress') {
        throw new ProviderError('rejected', 'HTTP 400: previous interaction is in progress')
      }
    }
    const interaction: Interaction = {
      id: `int_${++this.seq}`,
      environmentId,
      status: 'in_progress',
      input: turn.input,
      steps: []
    }
    this.interactions.set(interaction.id, interaction)
    if (this.dropNextResponse) {
      this.dropNextResponse = false
      throw new ProviderError('uncertain', 'Provider request failed: socket hang up')
    }
    return view(interaction)
  }

  readonly cancels: string[] = []
  /** When set, a cancel is accepted but the turn keeps running until the next poll. */
  slowCancel = false

  /** Documented: only a running background interaction can be cancelled. */
  cancel(id: string): ProviderInteraction {
    const interaction = this.interactions.get(id)
    if (!interaction) throw new ProviderError('gone', 'HTTP 404')
    this.cancels.push(id)
    if (interaction.status !== 'in_progress')
      throw new ProviderError('rejected', 'HTTP 400: interaction is not running')
    if (!this.slowCancel) interaction.status = 'cancelled'
    return view(interaction)
  }

  /** The agent finishes its turn the first time the interaction is polled after creation. */
  get(id: string): ProviderInteraction {
    const interaction = this.interactions.get(id)
    if (!interaction) throw new ProviderError('gone', 'HTTP 404')
    if (interaction.status === 'in_progress') this.run(interaction)
    return view(interaction)
  }

  readFile(environmentId: string, path: string): string {
    const env = this.environments.get(environmentId)
    const file = env && join(env.root, path.replace(/^\/workspace\//, ''))
    if (!env || env.expired || !file || !existsSync(file))
      throw new ProviderError('gone', 'HTTP 404')
    return readFileSync(file, 'utf8')
  }

  environmentStatus(environmentId: string): 'active' | 'expired' | 'gone' {
    const env = this.environments.get(environmentId)
    return !env ? 'gone' : env.expired ? 'expired' : 'active'
  }

  private run(interaction: Interaction): void {
    const turn =
      [...this.interactions.values()].filter((i) => i.environmentId === interaction.environmentId)
        .length - 1
    const { root } = this.environments.get(interaction.environmentId)!
    const command = /node \/workspace\/\.diogenes\/export-candidate\.mjs ([0-9a-f]{32})/.exec(
      interaction.input
    )
    this.agent[turn]({
      repo: join(root, 'repo'),
      input: interaction.input,
      exportCandidate: () => {
        const output = execFileSync(
          'node',
          [join(root, '.diogenes/export-candidate.mjs'), command![1]],
          { env: { ...process.env, DIOGENES_WORKSPACE_ROOT: root }, encoding: 'utf8' }
        )
        interaction.steps.push(
          { type: 'command', text: command![0] },
          { type: 'command_output', text: output }
        )
      }
    })
    interaction.steps.push({ type: 'text', text: `Turn ${turn} done.` })
    interaction.status = 'completed'
  }
}

/** A client of the fake server. Create a new one to simulate a Diogenes restart. */
export class FakeProvider implements ManagedAgentProvider {
  readonly agent = 'fake-antigravity'
  constructor(private readonly server: FakeServer) {}
  create = async (turn: CreateTurn): Promise<ProviderInteraction> => this.server.create(turn)
  get = async (id: string): Promise<ProviderInteraction> => this.server.get(id)
  cancel = async (id: string): Promise<ProviderInteraction> => this.server.cancel(id)
  readFile = async (env: string, path: string): Promise<string> => this.server.readFile(env, path)
  environmentStatus = async (env: string): Promise<'active' | 'expired' | 'gone'> =>
    this.server.environmentStatus(env)
}

function view(i: Interaction): ProviderInteraction {
  return { id: i.id, status: i.status, environmentId: i.environmentId, steps: [...i.steps] }
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
