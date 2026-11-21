import { join } from 'path'
import { getFileText } from '../github'
import { readIndexedGraph } from '../indexing/ipc'
import { DesignService } from './harness'
import type { ThreadHistory } from './history'
import { geminiModelClient } from './model'
import { DesignStore } from './store'
import type { SourceReader, VerificationSource } from './tools'

export { DesignService } from './harness'
export { MemoryThreadHistory, type ThreadHistory, type ThreadMessage } from './history'
export type { SourceReader, VerificationSource } from './tools'

export const DESIGN_MODELS = ['gemini-4-carbon', 'gemini-4-hydrogen'] as const

/** Reads files at the exact commit through the signed-in GitHub session. */
export const githubSourceReader: SourceReader = async (repository, commitSha, path) => {
  try {
    return await getFileText(repository.fullName, commitSha, path)
  } catch {
    return null
  }
}

/**
 * Production wiring: drafts under `<userData>/design`, the indexed catalog as revision 0, sources
 * from GitHub at the draft commit, and the standard Gemini API. The thread service and the
 * verification service are passed in by whoever owns them.
 */
export function createDesignService(opts: {
  userData: string
  history: ThreadHistory
  verification: VerificationSource
}): DesignService {
  return new DesignService({
    store: new DesignStore(join(opts.userData, 'design')),
    observedCatalog: async (repositoryId) => (await readIndexedGraph(repositoryId))?.catalog ?? null,
    readSource: githubSourceReader,
    verification: opts.verification,
    history: opts.history,
    model: geminiModelClient(),
    models: DESIGN_MODELS
  })
}
