/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS run in the sandbox */
// Staged into the managed workspace as /workspace/.diogenes/export-candidate.mjs and run by the
// coding agent as the last step of every turn: `node export-candidate.mjs <turnToken>`.
// Diogenes never trusts the agent's description of its change; it downloads the file written here.
//
// The script rebuilds the pinned base from the staged copies in .diogenes/base, overlays the
// current workspace, and writes `git diff --binary` against that base to
// .diogenes/out/candidate.json with its sha256 and the turn token, so a stale, truncated or
// rewritten candidate is detected on retrieval.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

// DIOGENES_WORKSPACE_ROOT lets tests run this script against a local directory.
const root = process.env.DIOGENES_WORKSPACE_ROOT ?? '/workspace'
const workspace = join(root, 'repo')
const control = join(root, '.diogenes')
const token = process.argv[2]
if (!/^[0-9a-f]{32}$/.test(token ?? '')) throw new Error('Usage: export-candidate.mjs <turnToken>')
const manifest = JSON.parse(readFileSync(join(control, 'manifest.json'), 'utf8'))
const skip = new Set(['.git', 'node_modules'])

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString()}`)
  return r.stdout
}

function files(dir, root = dir) {
  return readdirSync(dir).flatMap((name) => {
    if (skip.has(name)) return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path, root) : [relative(root, path)]
  })
}

const tmp = mkdtempSync(join(tmpdir(), 'diogenes-'))
try {
  git(tmp, ['init', '-q'])
  git(tmp, ['config', 'user.email', 'agent@diogenes.invalid'])
  git(tmp, ['config', 'user.name', 'Diogenes'])
  cpSync(join(control, 'base'), tmp, { recursive: true })
  git(tmp, ['add', '-A'])
  git(tmp, ['commit', '-q', '--allow-empty', '-m', 'base'])
  for (const path of files(tmp)) rmSync(join(tmp, path))
  for (const path of files(workspace)) {
    mkdirSync(dirname(join(tmp, path)), { recursive: true })
    cpSync(join(workspace, path), join(tmp, path))
  }
  git(tmp, ['add', '-A'])
  const patch = git(tmp, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', 'HEAD'])
  const sha256 = createHash('sha256').update(patch).digest('hex')
  const out = join(control, 'out')
  mkdirSync(out, { recursive: true })
  const report = {
    version: 1,
    token,
    sourceDigest: manifest.sourceDigest,
    sha256,
    patch: patch.toString('base64')
  }
  writeFileSync(join(out, 'candidate.json.tmp'), JSON.stringify(report))
  renameSync(join(out, 'candidate.json.tmp'), join(out, 'candidate.json'))
  console.log(`DIOGENES_CANDIDATE_WRITTEN token=${token} sha256=${sha256} bytes=${patch.length}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
