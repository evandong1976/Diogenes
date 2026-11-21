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

test('AWS services get their own icon, ahead of the engine they run', () => {
  expect(brandFor(node('AWS S3'))?.title).toBe('Amazon S3')
  expect(brandFor(node('AWS RDS', { detail: 'Postgres for uploads' }))?.title).toBe('Amazon RDS')
  expect(brandFor(node('Uploads', { detail: 'Stored in Amazon S3 buckets' }))?.title).toBe(
    'Amazon S3'
  )
  expect(brandFor(node('AWS'))?.title).toBe('AWS')
  expect(brandFor(node('User sessions', { id: 'x' }))).toBeNull()
})
