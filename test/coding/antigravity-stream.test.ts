import { describe, expect, it, vi } from 'vitest'
import { createAntigravityProvider } from '../../src/main/coding/antigravity'

describe('managed coding activity', () => {
  it('replays tool activity while the interaction is in progress', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('stream=true')) {
        const events = [
          {
            event_type: 'step.start',
            step: {
              type: 'function_call',
              name: 'view_file',
              arguments: { AbsolutePath: '/workspace/repo/src/index.ts' }
            }
          },
          {
            event_type: 'step.start',
            step: { type: 'function_result', name: 'view_file', result: 'private source text' }
          }
        ]
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' }
        })
      }
      return Response.json({ id: 'interaction', status: 'in_progress' })
    })
    const provider = createAntigravityProvider({ apiKey: 'test', fetch: fetcher as typeof fetch })
    const result = await provider.get('interaction')
    expect(result.steps.map((step) => step.text)).toEqual(['Reading file · src/index.ts'])
  })
})
