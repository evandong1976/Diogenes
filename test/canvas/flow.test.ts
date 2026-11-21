import { expect, test } from 'vitest'
import {
  EXAMPLE_DRAFT,
  EXAMPLE_FLOW,
  changeBrief,
  flowLayout
} from '../../src/renderer/src/canvas/flow'
import { validateAppFlow } from '../../src/main/gemini/contracts'

test('the brief lists notes, proposed boxes and arrows by name', () => {
  const brief = changeBrief(EXAMPLE_FLOW, {
    ...EXAMPLE_DRAFT,
    boxes: [
      {
        id: 'new-1',
        kind: 'data',
        name: 'Supabase',
        summary: '',
        tables: ['users'],
        paths: [],
        proposed: true
      }
    ],
    links: [{ id: 'l', from: 'auth', to: 'new-1', label: 'creates user', proposed: true }],
    notes: [...EXAMPLE_DRAFT.notes, { id: 'blank', text: '  ' }]
  })
  expect(brief).toBe(
    [
      '- On "User database": I want this on Supabase',
      '- Add data "Supabase" with tables users',
      '- Connect "OAuth sign-in" → "Supabase" (creates user)'
    ].join('\n')
  )
  expect(changeBrief(EXAMPLE_FLOW, { boxes: [], links: [], notes: [], positions: {} })).toBe('')
})

test('screens sit left of logic, logic left of data', () => {
  const at = flowLayout(EXAMPLE_FLOW.boxes)
  expect(at.get('game-board')!.x).toBeLessThan(at.get('word-logic')!.x)
  expect(at.get('word-logic')!.x).toBeLessThan(at.get('user-db')!.x)
})

test("Gemini's map keeps only real files and arrows between real boxes", () => {
  const flow = validateAppFlow(
    {
      boxes: [
        {
          id: 'a',
          kind: 'screen',
          name: 'A',
          summary: 'Shows A.',
          tables: [],
          paths: ['src/a.tsx', 'nope.ts']
        },
        { id: 'b', kind: 'data', name: 'B', summary: 'Keeps B.', tables: ['users'], paths: [] }
      ],
      links: [
        { id: 'a->b', from: 'a', to: 'b' },
        { id: 'a->z', from: 'a', to: 'z', label: 'reads' }
      ]
    },
    new Set(['src/a.tsx'])
  )
  expect(flow.boxes[0].paths).toEqual(['src/a.tsx'])
  expect(flow.links).toEqual([{ id: 'a->b', from: 'a', to: 'b', label: '' }])
  expect(() =>
    validateAppFlow({ boxes: [{ id: 'a', kind: 'robot' }], links: [] }, new Set())
  ).toThrow()
})
