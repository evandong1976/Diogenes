import { expect, test } from 'vitest'
import { brandFor, methodOf, shapeFor } from '../../src/renderer/src/canvas/brands'
import type { DiagramNode } from '../../src/renderer/src/canvas/diagrams'

const node = (label: string, extra: Partial<DiagramNode> = {}): DiagramNode => ({
  id: `package:${label}`,
  kind: 'Database',
  label,
  meta: '',
  change: 'unchanged',
  sources: [],
  ...extra
})

test('brands, shapes and methods', () => {
  expect(brandFor(node('mongoose'))?.title).toBe('MongoDB')
  expect(brandFor(node('pg'))?.title).toBe('PostgreSQL')
  expect(brandFor(node('@supabase/supabase-js'))?.title).toBe('Supabase')
  expect(brandFor(node('ioredis'))?.title).toBe('Redis')
  expect(brandFor(node('next step', { id: 'x' }))).toBeNull()
  expect(shapeFor(node('pg'), 'resource')).toBe('store')
  expect(shapeFor(node('jobs', { type: 'QUEUE' }), 'resource')).toBe('queue')
  expect(methodOf(node('users', { detail: 'http POST /api/users' }))).toBe('POST')
})
