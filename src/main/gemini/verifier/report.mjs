// Diogenes verification reporter. Shipped to the managed agent's sandbox next to:
//   checks.json      the acceptance checks for the approved change (written by Diogenes)
//   original/        the source files as they were before the change
//   repo/            the same files, which the agent edits
// The agent writes repo/diogenes-checks.mjs, which must print one JSON line per check:
//   {"id": "<check id>", "passed": true|false, "detail": "<what it observed>"}
// This script runs it, keeps only results for known check IDs (anything missing fails), works
// out the diff itself, and prints one `DIOGENES_RESULT {...}` line that Diogenes reads.

/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by Node in the sandbox */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.env.DIOGENES_ROOT ?? dirname(fileURLToPath(import.meta.url))
const repo = join(root, 'repo')
const original = join(root, 'original')
const { checks } = JSON.parse(readFileSync(join(root, 'checks.json'), 'utf8'))
const script = join(repo, 'diogenes-checks.mjs')

const reported = new Map()
let problem = null
if (!existsSync(script)) {
  problem = 'repo/diogenes-checks.mjs was not written.'
} else {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', script], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 120_000
  })
  for (const line of (run.stdout ?? '').split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue
    try {
      const result = JSON.parse(line)
      if (typeof result?.id === 'string' && typeof result.passed === 'boolean') {
        reported.set(result.id, result)
      }
    } catch {
      // Not a result line.
    }
  }
  if (run.error) problem = `diogenes-checks.mjs did not run: ${run.error.message}`
  else if (reported.size === 0) {
    const stderr = (run.stderr ?? '').trim().slice(-600)
    problem = `diogenes-checks.mjs reported no results (exit ${run.status}).${stderr ? ` ${stderr}` : ''}`
  }
}

const tests = checks.map((check) => {
  const result = reported.get(check.id)
  return {
    id: check.id,
    name: check.description,
    passed: result?.passed === true,
    detail: result
      ? String(result.detail ?? '').slice(0, 300)
      : (problem ?? 'Not reported by diogenes-checks.mjs.')
  }
})

/** Repo-relative paths of every file under `dir`, with '/' separators. */
function files(dir) {
  if (!existsSync(dir)) return []
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === '.git') continue
      const full = join(d, name)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(relative(dir, full).split(sep).join('/'))
    }
  }
  walk(dir)
  return out
}

// Changed source files, not counting the agent's own checks script.
const before = new Set(files(original))
const changedFiles = files(repo)
  .filter((path) => path !== 'diogenes-checks.mjs')
  .filter(
    (path) =>
      !before.has(path) ||
      readFileSync(join(repo, path), 'utf8') !== readFileSync(join(original, path), 'utf8')
  )
  .sort()

const git = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--', 'original', 'repo'], {
  cwd: root,
  encoding: 'utf8'
})
// Exit 1 means "files differ"; anything else means git couldn't diff.
const diff =
  git.status === 0 || git.status === 1
    ? git.stdout
    : changedFiles.map((path) => `changed: ${path}`).join('\n')

console.log('DIOGENES_RESULT ' + JSON.stringify({ tests, diff, changedFiles }))
