import { createHash } from 'crypto'
import { posix } from 'path'
import type { CodingHandoff, SourceFile } from '../../shared/codingRun'

export const workspaceRoot = '/workspace/repo'
export const controlRoot = '/workspace/.diogenes'
export const exportCommand = (token: string): string =>
  `node ${controlRoot}/export-candidate.mjs ${token}`

export const sha256 = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex')

const SHA = /^[0-9a-f]{40}$/
const DIGEST = /^[0-9a-f]{64}$/

function normalize(path: string): string {
  const clean = posix.normalize(path)
  if (!path || posix.isAbsolute(clean) || clean === '.' || clean.startsWith('..')) {
    throw new Error(`Path is not repo-relative: ${path}`)
  }
  return clean
}

/** True when `path` is a scope entry or lies under a scope entry that names a directory. */
export function inScope(path: string, scope: string[]): boolean {
  return scope.some((entry) => {
    const s = entry.replace(/\/+$/, '')
    return path === s || path.startsWith(`${s}/`)
  })
}

/** Rejects handoffs and sources that would send more than the approved task needs. */
export function validateStart(handoff: CodingHandoff, files: SourceFile[]): void {
  if (!handoff?.handoffId || typeof handoff.handoffId !== 'string')
    throw new Error('Handoff ID missing.')
  if (!DIGEST.test(handoff.digest ?? '')) throw new Error('Handoff digest must be sha256 hex.')
  if (!SHA.test(handoff.baseCommit ?? '')) throw new Error('Base commit must be a full SHA.')
  if (!handoff.intent?.trim()) throw new Error('Handoff intent is empty.')
  for (const list of [handoff.guarantees, handoff.latitude, handoff.scope]) {
    if (!Array.isArray(list) || !list.every((s) => typeof s === 'string')) {
      throw new Error('Handoff guarantees, latitude and scope must be string lists.')
    }
  }
  if (handoff.scope.length === 0) throw new Error('Handoff scope is empty.')
  handoff.scope.forEach(normalize)
  if (!Array.isArray(files) || files.length === 0) throw new Error('No source files supplied.')
  const seen = new Set<string>()
  for (const file of files) {
    if (typeof file?.content !== 'string') throw new Error('Source file content must be text.')
    const path = normalize(file.path)
    if (path !== file.path) throw new Error(`Source path must be normalized: ${file.path}`)
    if (seen.has(path)) throw new Error(`Duplicate source file: ${path}`)
    seen.add(path)
    if (path.startsWith('.diogenes/')) throw new Error('`.diogenes/` is reserved.')
    if (!inScope(path, handoff.scope)) throw new Error(`Source file outside scope: ${path}`)
  }
}

/** Order-independent digest of exactly what was staged. */
export function sourceDigest(files: SourceFile[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${sha256(f.content)}  ${f.path}`)
  return sha256(lines.join('\n') + '\n')
}

/** Repo-relative paths a `git diff` touches, from its headers. */
export function patchPaths(patch: string): string[] {
  const paths = new Set<string>()
  for (const line of patch.split('\n')) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (m) {
      paths.add(m[1])
      paths.add(m[2])
    }
  }
  return [...paths].sort()
}

export type ParsedCandidate =
  { ok: true; patch: string; patchSha256: string; files: string[] } | { ok: false; reason: string }

/**
 * Checks a downloaded `candidate.json` against what was staged and the turn that should have
 * produced it: same turn, same sources, intact bytes, only in-scope paths, at least one change.
 */
export function parseCandidate(
  file: string,
  expected: { token: string; sourceDigest: string; scope: string[] }
): ParsedCandidate {
  let report: {
    version?: number
    token?: string
    sourceDigest?: string
    sha256?: string
    patch?: string
  }
  try {
    report = JSON.parse(file)
  } catch {
    return { ok: false, reason: 'The candidate file is truncated or malformed.' }
  }
  if (report?.version !== 1 || typeof report.patch !== 'string') {
    return { ok: false, reason: 'The candidate file has an unknown format.' }
  }
  if (report.token !== expected.token) {
    return { ok: false, reason: 'The agent did not export a candidate in this turn.' }
  }
  if (report.sourceDigest !== expected.sourceDigest) {
    return { ok: false, reason: 'The candidate was exported from different sources.' }
  }
  const bytes = Buffer.from(report.patch, 'base64')
  const digest = sha256(bytes)
  if (digest !== report.sha256) {
    return { ok: false, reason: 'The candidate patch does not match its checksum.' }
  }
  const patch = bytes.toString('utf8')
  const files = patchPaths(patch)
  if (files.length === 0) return { ok: false, reason: 'The candidate makes no changes.' }
  const outside = files.filter((path) => !inScope(path, expected.scope))
  if (outside.length) {
    return { ok: false, reason: `The candidate changes files outside scope: ${outside.join(', ')}` }
  }
  return { ok: true, patch, patchSha256: digest, files }
}

// Documented inline-source limits: 1 MB per file, 2 MB per request.
const fileLimit = 1_000_000
const totalLimit = 2_000_000

/**
 * The files staged on the first turn: the scoped sources, a pristine copy as the diff base,
 * the manifest, and the export script. Paths are fixed so the agent cannot be pointed elsewhere.
 */
export function stagedSources(
  files: SourceFile[],
  exportScript: string
): { target: string; content: string }[] {
  const digest = sourceDigest(files)
  const staged = [
    ...files.map((f) => ({ target: `${workspaceRoot}/${f.path}`, content: f.content })),
    ...files.map((f) => ({ target: `${controlRoot}/base/${f.path}`, content: f.content })),
    { target: `${controlRoot}/manifest.json`, content: JSON.stringify({ sourceDigest: digest }) },
    { target: `${controlRoot}/export-candidate.mjs`, content: exportScript }
  ]
  let total = 0
  for (const s of staged) {
    const size = Buffer.byteLength(s.content)
    if (size > fileLimit) throw new Error(`Source file is over the 1 MB inline limit: ${s.target}`)
    total += size
  }
  if (total > totalLimit) throw new Error('Staged sources are over the 2 MB inline limit.')
  return staged
}

export const candidatePath = `${controlRoot}/out/candidate.json`
