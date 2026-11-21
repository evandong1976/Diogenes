import { createReadStream, createWriteStream } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'path'
import { pipeline } from 'stream/promises'
import { Transform } from 'stream'
import { Parser, type ReadEntry } from 'tar'
import type { FileRecord } from '../../shared/indexing'
import { classifyPath } from './languages'

export type SnapshotLimits = {
  /** Max bytes of the downloaded archive. */
  maxArchiveBytes: number
  /** Max total bytes written to disk. */
  maxExtractedBytes: number
  /** Max archive entries examined. */
  maxEntries: number
  /** Files above this size are recorded but not written. */
  maxFileBytes: number
}

export const DEFAULT_LIMITS: SnapshotLimits = {
  maxArchiveBytes: 512 * 1024 * 1024,
  maxExtractedBytes: 1024 * 1024 * 1024,
  maxEntries: 200_000,
  maxFileBytes: 1024 * 1024
}

export type ExtractResult = {
  files: FileRecord[]
  /** Top-level directory of the archive (GitHub: `owner-repo-<shortsha>`). */
  rootDir: string | null
  /** Commit recorded in the archive's pax global header, when present. */
  archiveCommit: string | null
}

export class SnapshotError extends Error {}

/**
 * Validates a path from an archive and returns it relative to the snapshot root,
 * or a rejection reason. The first path component (the archive's top folder) is stripped.
 */
export function safeRelativePath(raw: string, dest: string): { path: string } | { reason: string } {
  if (raw.includes('\0')) return { reason: 'nul-in-path' }
  const normalized = raw.replace(/\\/g, '/')
  if (isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')) {
    return { reason: 'absolute-path' }
  }
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) return { reason: 'path-traversal' }
  const rel = parts.slice(1).join('/')
  if (!rel) return { path: '' }
  const abs = resolve(dest, rel)
  if (abs !== dest && !abs.startsWith(dest + sep)) return { reason: 'escapes-snapshot' }
  return { path: rel }
}

/**
 * Extracts a gzipped tarball into `dest`, writing only files an indexer can use.
 * Links and special files are never created. Every entry is accounted for in `files`.
 */
export async function extractSnapshot(
  archivePath: string,
  dest: string,
  limits: SnapshotLimits = DEFAULT_LIMITS
): Promise<ExtractResult> {
  const files: FileRecord[] = []
  let rootDir: string | null = null
  let archiveCommit: string | null = null
  let entries = 0
  let written = 0
  let failure: Error | null = null
  const writes: Promise<void>[] = []

  const reject = (path: string, reason: string, bytes = 0): void => {
    files.push({ path, status: 'rejected', language: null, bytes, reason })
  }

  const onEntry = (entry: ReadEntry): void => {
    entries++
    if (!archiveCommit && entry.globalExtended?.comment) {
      archiveCommit = String(entry.globalExtended.comment).trim()
    }
    if (failure || entries > limits.maxEntries) {
      failure ??= new SnapshotError(`Archive has more than ${limits.maxEntries} entries.`)
      entry.resume()
      return
    }
    const raw = entry.path
    const top = raw.replace(/\\/g, '/').split('/')[0]
    if (rootDir === null && top && !top.includes('..')) rootDir = top
    const checked = safeRelativePath(raw, dest)
    const size = entry.size ?? 0

    if ('reason' in checked) {
      reject(raw, checked.reason, size)
      entry.resume()
      return
    }
    const rel = checked.path
    if (entry.type === 'Directory' || rel === '') {
      entry.resume()
      return
    }
    if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
      // Never followed or created: a link could point outside the snapshot.
      reject(rel, entry.type === 'SymbolicLink' ? 'symlink-not-followed' : 'hardlink-not-followed')
      entry.resume()
      return
    }
    if (entry.type !== 'File' && entry.type !== 'OldFile' && entry.type !== 'ContiguousFile') {
      reject(rel, `unsupported-entry-type:${entry.type}`)
      entry.resume()
      return
    }

    const cls = classifyPath(rel)
    if (!cls.extract) {
      files.push({
        path: rel,
        status: 'skipped',
        language: cls.language,
        bytes: size,
        reason: cls.reason
      })
      entry.resume()
      return
    }
    if (size > limits.maxFileBytes) {
      files.push({
        path: rel,
        status: 'skipped',
        language: cls.language,
        bytes: size,
        reason: 'too-large'
      })
      entry.resume()
      return
    }
    if (written + size > limits.maxExtractedBytes) {
      failure = new SnapshotError(`Snapshot exceeds ${limits.maxExtractedBytes} bytes on disk.`)
      entry.resume()
      return
    }
    written += size
    // Provisional; the indexer marks analyzed files later.
    files.push({
      path: rel,
      status: 'skipped',
      language: cls.language,
      bytes: size,
      reason: cls.reason
    })
    const target = resolve(dest, rel)
    entry.pause()
    writes.push(
      (async () => {
        await mkdir(dirname(target), { recursive: true })
        let seen = 0
        const cap = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            seen += chunk.length
            if (seen > size) cb(new SnapshotError(`Entry ${rel} is larger than its header says.`))
            else cb(null, chunk)
          }
        })
        // `wx` refuses to overwrite: duplicate entries cannot replace an earlier file.
        await pipeline(entry, cap, createWriteStream(target, { flags: 'wx', mode: 0o644 }))
      })().catch((e: Error) => {
        failure ??= e
        entry.resume()
      })
    )
  }

  const parser = new Parser({ onReadEntry: onEntry, strict: true })
  let archiveBytes = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      archiveBytes += chunk.length
      if (archiveBytes > limits.maxArchiveBytes) {
        cb(new SnapshotError(`Archive exceeds ${limits.maxArchiveBytes} bytes.`))
      } else cb(null, chunk)
    }
  })
  await pipeline(createReadStream(archivePath), counter, parser)
  await Promise.all(writes)
  if (failure) throw failure
  return { files, rootDir, archiveCommit }
}
