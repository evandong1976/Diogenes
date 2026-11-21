import { describe, expect, it } from 'vitest'
import {
  sanitizeWhiteboard,
  validateWhiteboardEdit
} from '../../src/main/design/whiteboard'

const board = sanitizeWhiteboard({
  boxes: [
    { id: 'web', kind: 'screen', name: 'Web', summary: '', tables: [], paths: ['src/app.tsx'] },
    { id: 'db', kind: 'data', name: 'DB', summary: '', tables: [], paths: ['../etc/passwd', 'db.sql'] },
    { id: 'bad', kind: 'robot', name: 'Bad' }
  ],
  links: [
    { id: 'web->db', from: 'web', to: 'db', label: 'SQL' },
    { id: 'web->bad', from: 'web', to: 'bad', label: '' }
  ],
  notes: [{ text: 'use firebase', target: 'db' }, { text: '   ' }, { text: 'x', target: 'nope' }]
})!

describe('whiteboard checks', () => {
  it('keeps only well-formed boxes, safe paths, real arrows and non-empty notes', () => {
    expect(board.boxes.map((b) => b.id)).toEqual(['web', 'db'])
    expect(board.boxes[1].paths).toEqual(['db.sql'])
    expect(board.links.map((l) => l.id)).toEqual(['web->db'])
    expect(board.notes).toEqual([{ text: 'use firebase', target: 'db' }, { text: 'x' }])
    expect(sanitizeWhiteboard(null)).toBeUndefined()
    expect(sanitizeWhiteboard({ boxes: 'no' })).toBeUndefined()
  })

  it('accepts a coherent edit and rejects ones that point at nothing', () => {
    const edit = validateWhiteboardEdit(
      {
        summary: 'Swap to Firebase.',
        addBoxes: [{ id: 'fb', kind: 'data', name: 'Firebase' }],
        removeBoxIds: ['db'],
        addLinks: [{ from: 'web', to: 'fb' }]
      },
      board
    )
    expect(edit).toEqual({
      summary: 'Swap to Firebase.',
      addBoxes: [{ id: 'fb', kind: 'data', name: 'Firebase', summary: '', tables: [] }],
      updateBoxes: [],
      removeBoxIds: ['db'],
      addLinks: [{ from: 'web', to: 'fb', label: '' }],
      removeLinkIds: []
    })
    const bad = (args: Record<string, unknown>): string => {
      try {
        validateWhiteboardEdit({ summary: 'x', ...args }, board)
        return 'accepted'
      } catch (e) {
        return (e as Error).message
      }
    }
    expect(bad({ removeBoxIds: ['ghost'] })).toMatch(/No box ghost/)
    expect(bad({ addBoxes: [{ id: 'web', kind: 'data', name: 'Dup' }] })).toMatch(/already exists/)
    expect(bad({ addBoxes: [{ id: 'x', kind: 'robot', name: 'X' }] })).toMatch(/kind/)
    expect(bad({ removeBoxIds: ['db'], addLinks: [{ from: 'web', to: 'db' }] })).toMatch(/exist after/)
    expect(bad({ updateBoxes: [{ id: 'web' }] })).toMatch(/changes nothing/)
    expect(bad({})).toMatch(/changes nothing/)
    expect(() => validateWhiteboardEdit({ removeBoxIds: ['db'] }, board)).toThrow(/summary/)
  })
})
