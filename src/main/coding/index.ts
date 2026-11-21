import { join } from 'path'
import exportScript from './export-candidate.mjs?raw'
import { createAntigravityProvider } from './antigravity'
import { CodingRunGateway } from './gateway'
import { CodingRunStore } from './store'
import type { ManagedAgentProvider } from './provider'

export { CodingRunGateway } from './gateway'
export type { ManagedAgentProvider } from './provider'

/**
 * The managed coding gateway for the main process. Runs persist under `<dataDir>/coding-runs`.
 * The API key is read here and never leaves this process.
 */
export function createCodingRunGateway(options: {
  dataDir: string
  provider?: ManagedAgentProvider
}): CodingRunGateway {
  let provider = options.provider
  if (!provider) {
    const apiKey = process.env.GEMINI_API_KEY?.trim()
    if (!apiKey) throw new Error('GEMINI_API_KEY is missing from the main-process environment.')
    provider = createAntigravityProvider({ apiKey })
  }
  return new CodingRunGateway({
    store: new CodingRunStore(join(options.dataDir, 'coding-runs')),
    provider,
    exportScript
  })
}
