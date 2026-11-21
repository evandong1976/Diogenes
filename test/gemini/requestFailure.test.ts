import { afterEach, describe, expect, it, vi } from 'vitest'
import { generate, requestFailure } from '../../src/main/gemini/service'

describe('requestFailure', () => {
  it('reports our own timeout as a timeout, not as unreachable', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    expect(requestFailure('gemini-4-carbon', timeout, 180_000).message).toBe(
      'Gemini gemini-4-carbon did not answer within 180 seconds.'
    )
  })

  it('keeps the network error code when the API really is unreachable', () => {
    const network = new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
    expect(requestFailure('gemini-4-hydrogen', network, 60_000).message).toBe(
      'Could not reach the Gemini API for gemini-4-hydrogen (ENOTFOUND).'
    )
  })
})

describe('generate timeouts', () => {
  const key = process.env.GEMINI_API_KEY
  afterEach(() => {
    vi.unstubAllGlobals()
    if (key === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = key
  })

  it('aborts after the timeout it was given and says so', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    // A request that never answers: only the abort signal ends it.
    vi.stubGlobal(
      'fetch',
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_, reject) =>
          init.signal.addEventListener('abort', () => reject(init.signal.reason))
        )
    )
    await expect(
      generate('gemini-4-carbon', 'instruction', [{ text: 'x' }], {}, { timeoutMs: 50 })
    ).rejects.toThrow('did not answer within 0 seconds')
  })
})
