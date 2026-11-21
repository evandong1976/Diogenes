import { mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadStore } from '../../src/main/threads/store'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'diogenes-threads-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('ThreadStore', () => {
  it('reopens isolated project threads from a fresh instance with order and run refs intact', async () => {
    const writer = new ThreadStore(root)
    const design = await writer.create('101', { kind: 'design', title: 'Refund retry' })
    const coding = await writer.create('202', { kind: 'coding', title: 'Implement retry' })

    await writer.append('101', design.id, [
      {
        id: 'u1',
        type: 'user_message',
        text: 'Retry refunds once',
        context: { selectedComponentIds: ['refund'] }
      },
      {
        id: 'c1',
        type: 'tool_call',
        callId: 'call-1',
        name: 'propose_edit',
        args: { componentId: 'refund' }
      },
      {
        id: 'r1',
        type: 'tool_result',
        callId: 'call-1',
        name: 'propose_edit',
        ok: true,
        result: { proposalId: 'p1' }
      },
      {
        id: 'a1',
        type: 'assistant_message',
        text: 'Proposed revision 4.',
        refs: [{ kind: 'draftRevision', draftId: 'd1', revision: 4 }]
      }
    ])
    await writer.append('101', design.id, {
      id: 'h1',
      type: 'reference',
      note: 'Approved and handed off',
      refs: [
        { kind: 'handoff', handoffId: 'h-1' },
        { kind: 'codingRun', runId: 'run-7' }
      ]
    })
    await writer.append('202', coding.id, {
      id: 'u1',
      type: 'user_message',
      text: 'Start',
      refs: [{ kind: 'codingRun', runId: 'run-7' }]
    })
    await writer.setProvider('202', coding.id, {
      provider: 'gemini',
      status: 'expired',
      environmentId: 'env-9'
    })

    // Repeating an append (same id, same content) yields the stored event, not a new one.
    const retry = await writer.append('101', design.id, {
      id: 'a1',
      type: 'assistant_message',
      text: 'Proposed revision 4.',
      refs: [{ kind: 'draftRevision', draftId: 'd1', revision: 4 }]
    })
    expect(retry.duplicate).toEqual([true])
    expect(retry.events[0].seq).toBe(4)
    await expect(
      writer.append('101', design.id, { id: 'a1', type: 'assistant_message', text: 'changed' })
    ).rejects.toMatchObject({ code: 'conflict' })

    const reader = new ThreadStore(root)
    const reopened = await reader.open('101', design.id)
    expect(reopened.events.map((e) => [e.seq, e.id, e.type])).toEqual([
      [1, 'u1', 'user_message'],
      [2, 'c1', 'tool_call'],
      [3, 'r1', 'tool_result'],
      [4, 'a1', 'assistant_message'],
      [5, 'h1', 'reference']
    ])
    expect(reopened.events[4].refs).toEqual([
      { kind: 'handoff', handoffId: 'h-1' },
      { kind: 'codingRun', runId: 'run-7' }
    ])
    expect(reopened.events[0]).toMatchObject({ context: { selectedComponentIds: ['refund'] } })

    // Projects are isolated, and provider expiry leaves history readable.
    expect((await reader.list('101')).map((t) => t.id)).toEqual([design.id])
    expect((await reader.list('202')).map((t) => t.id)).toEqual([coding.id])
    const codingThread = await reader.open('202', coding.id)
    expect(codingThread.provider).toMatchObject({ status: 'expired', environmentId: 'env-9' })
    expect(codingThread.events).toHaveLength(1)
    expect(codingThread.events[0].refs).toEqual([{ kind: 'codingRun', runId: 'run-7' }])
    await expect(reader.open('101', coding.id)).rejects.toMatchObject({ code: 'not_found' })
    expect(await reader.eventsSince('101', design.id, 3)).toHaveLength(2)
  })

  it('serializes concurrent appends, honors expectedLastSeq, and ignores interrupted temp files', async () => {
    const store = new ThreadStore(root)
    const t = await store.create('101', { kind: 'design' })
    const changes: number[] = []
    store.subscribe((c) => changes.push(c.lastSeq))

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.append('101', t.id, { id: `m${i}`, type: 'user_message', text: String(i) })
      )
    )
    // Same retry racing itself still lands once.
    await Promise.all([
      store.append('101', t.id, { id: 'dup', type: 'user_message', text: 'x' }),
      store.append('101', t.id, { id: 'dup', type: 'user_message', text: 'x' })
    ])
    await expect(
      store.append('101', t.id, { type: 'user_message', text: 'late' }, { expectedLastSeq: 3 })
    ).rejects.toMatchObject({ code: 'stale' })

    // A crash mid-write leaves only a temp file; the committed thread is unaffected.
    await writeFile(join(root, '101', `${t.id}.json.123.abc.tmp`), '{"trunc')
    const reopened = await new ThreadStore(root).open('101', t.id)
    expect(reopened.events.map((e) => e.seq)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1))
    expect(new Set(reopened.events.map((e) => e.id)).size).toBe(21)
    expect(changes).toEqual(Array.from({ length: 21 }, (_, i) => i + 1))
    expect((await new ThreadStore(root).list('101')).map((s) => s.lastSeq)).toEqual([21])
    expect((await readdir(join(root, '101'))).filter((n) => n.endsWith('.json'))).toHaveLength(1)
  })
})
