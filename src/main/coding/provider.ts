/**
 * The narrow port between the coding-run gateway and a managed agent provider. The live
 * implementation is `antigravity.ts`; tests use an in-memory fake.
 */

/** A file written into the remote workspace before the agent starts. */
export interface StagedFile {
  target: string
  content: string
}

export interface CreateTurn {
  input: string
  /** Only on the first turn. Later turns reuse the environment instead of restaging. */
  sources?: StagedFile[]
  /** Continue the conversation of this interaction. */
  previousInteractionId?: string
  /** Reuse this remote environment (its filesystem). */
  environmentId?: string
}

export interface ProviderStep {
  type: 'text' | 'command' | 'command_output' | 'other'
  text: string
  isError?: boolean
}

/** Documented interaction statuses. `queued` is not documented but was seen from older revisions. */
export type ProviderStatus =
  | 'queued'
  | 'in_progress'
  | 'requires_action'
  | 'requires_continuation'
  | 'completed'
  | 'incomplete'
  | 'failed'
  | 'cancelled'
  | (string & {})

export interface ProviderInteraction {
  id: string
  status: ProviderStatus
  environmentId?: string
  steps: ProviderStep[]
}

/**
 * - `rejected`: the provider refused the request; nothing was created.
 * - `uncertain`: the request may have reached the provider (timeout, network error, 5xx).
 * - `gone`: the interaction or environment no longer exists at the provider.
 */
export class ProviderError extends Error {
  constructor(
    readonly kind: 'rejected' | 'uncertain' | 'gone',
    message: string
  ) {
    super(message)
  }
}

export interface ManagedAgentProvider {
  readonly agent: string
  create(turn: CreateTurn): Promise<ProviderInteraction>
  get(interactionId: string): Promise<ProviderInteraction>
  /** Reads one file from a remote environment. `gone` if the file or environment is missing. */
  readFile(environmentId: string, path: string): Promise<string>
  /** `expired` or `gone` means the workspace can no longer be reused. */
  environmentStatus(environmentId: string): Promise<'active' | 'expired' | 'gone'>
}

export const isActive = (status: ProviderStatus): boolean =>
  status === 'queued' || status === 'in_progress'

/** The turn ended and the agent's work is preserved. `incomplete` means it ran out of budget. */
export const isFinished = (status: ProviderStatus): boolean =>
  status === 'completed' ||
  status === 'incomplete' ||
  status === 'requires_action' ||
  status === 'requires_continuation'
