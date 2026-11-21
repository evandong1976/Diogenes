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
// Files at a commit never change, so a read is fetched from GitHub once per app session.
// ponytail: unbounded in-memory map; cap it (LRU) if sessions start reading thousands of files.
const sourceCache = new Map<string, Promise<string | null>>()

export const githubSourceReader: SourceReader = (repository, commitSha, path) => {
  const key = `${repository.fullName}@${commitSha}:${path}`
  let file = sourceCache.get(key)
  if (!file) {
    file = getFileText(repository.fullName, commitSha, path).catch(() => {
      sourceCache.delete(key) // a failed fetch (rate limit, offline) is retried next time
      return null
    })
    sourceCache.set(key, file)
  }
  return file
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
