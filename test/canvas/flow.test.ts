import { expect, test } from 'vitest'
import {
  EXAMPLE_DRAFT,
  EXAMPLE_FLOW,
  applyWhiteboardEdit,
  boxComponent,
  changeBrief,
  flowLayout,
  whiteboardOf,
  type Box
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

// Just enough of a catalog for matching boxes: IDs, names and cited files.
const catalog = (nodes: { id: string; files: string[] }[]): Parameters<typeof boxComponent>[1] =>
  ({
    nodes: nodes.map(({ id, files }) => ({
      id,
      kind: 'module',
      name: `${id} name`,
      resolution: 'bound',
      properties: {},
      ports: [],
      sources: files.map((path) => ({ path }))
    })),
    edges: []
  }) as unknown as Parameters<typeof boxComponent>[1]

const box = (paths: string[]): Box => ({
  id: 'system-design-canvas',
  kind: 'screen',
  name: 'System design canvas',
  summary: '',
  tables: [],
  paths
})

test('a box is matched to the catalog component whose files it names', () => {
  const graph = catalog([
    {
      id: 'web',
      files: ['src/renderer/App.tsx', 'src/renderer/RepoPicker.tsx', 'src/renderer/x.ts']
    },
    { id: 'repo-picker', files: ['src/renderer/RepoPicker.tsx'] },
    { id: 'api', files: ['src/main/github.ts'] }
  ])
  // Named file beats a bigger component that also contains it.
  expect(boxComponent(box(['src/renderer/RepoPicker.tsx']), graph)).toEqual({
    componentId: 'repo-picker',
    name: 'repo-picker name'
  })
  // A folder: the component most fully inside it, then the smaller one.
  expect(boxComponent(box(['src/main']), graph)?.componentId).toBe('api')
  expect(boxComponent(box(['docs']), graph)).toBeNull()
  expect(boxComponent(box(['src/renderer/RepoPicker.tsx']), null)).toBeNull()
})

test('the brief names the component and files a note is about', () => {
  const flow = {
    boxes: [box(['src/renderer/RepoPicker.tsx'])],
    links: []
  }
  const brief = changeBrief(
    flow,
    {
      boxes: [],
      links: [],
      notes: [{ id: 'n', text: 'Ask for a GitHub link instead', target: 'system-design-canvas' }],
      positions: {}
    },
    catalog([{ id: 'repo-picker', files: ['src/renderer/RepoPicker.tsx'] }])
  )
  expect(brief).toBe(
    '- On "System design canvas" (component repo-picker; files src/renderer/RepoPicker.tsx): Ask for a GitHub link instead'
  )
})

test('an accepted chat edit swaps boxes in the draft and the brief lists it', () => {
  const flow = {
    boxes: [
      { id: 'web', kind: 'screen' as const, name: 'Web app', summary: '', tables: [], paths: [] },
      {
        id: 'db',
        kind: 'data' as const,
        name: 'Supabase Postgres',
        summary: 'Stores users.',
        tables: ['profiles'],
        paths: ['supabase/migrations/1.sql']
      }
    ],
    links: [{ id: 'web->db', from: 'web', to: 'db', label: 'SQL' }]
  }
  const draft = {
    boxes: [],
    links: [],
    notes: [{ id: 'n', text: 'Use Firebase', target: 'db' }],
    positions: {}
  }
  const next = applyWhiteboardEdit(flow, draft, {
    summary: 'Swap to Firebase.',
    addBoxes: [{ id: 'fb', kind: 'data', name: 'Firebase Firestore', summary: '', tables: [] }],
    updateBoxes: [{ id: 'web', summary: 'Talks to Firebase.' }],
    removeBoxIds: ['db'],
    addLinks: [
      { from: 'web', to: 'fb', label: 'SDK' },
      { from: 'web', to: 'gone', label: 'stale' }
    ],
    removeLinkIds: []
  })
  // The old box and its arrow stay drawn, marked removed; the arrow to a missing box is dropped.
  expect(next.removed).toEqual(['db', 'web->db'])
  expect(next.boxes.map((b) => [b.id, b.proposed])).toEqual([['fb', true]])
  expect(next.links.map((l) => [l.from, l.to, l.label])).toEqual([['web', 'fb', 'SDK']])
  expect(next.changed).toEqual({ web: { summary: 'Talks to Firebase.' } })

  // The agent's next snapshot leaves out what's being removed.
  const board = whiteboardOf(flow, next)
  expect(board.boxes.map((b) => b.id)).toEqual(['web', 'fb'])
  expect(board.links.map((l) => l.to)).toEqual(['fb'])
  expect(board.notes).toEqual([{ text: 'Use Firebase' }])

  expect(changeBrief(flow, next).split('\n')).toEqual([
    '- On "Supabase Postgres" (files supabase/migrations/1.sql): Use Firebase',
    '- Remove "Supabase Postgres" (files supabase/migrations/1.sql)',
    '- Remove the arrow "Web app" → "Supabase Postgres"',
    '- Change "Web app": now: Talks to Firebase.',
    '- Add data "Firebase Firestore"',
    '- Connect "Web app" → "Firebase Firestore" (SDK)'
  ])
})
