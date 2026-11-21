/**
 * Local git copies of authorized repositories, holding exactly the commits approvals name.
 *
 * Each project gets one bare repository under the backend's data directory. When an approval or
 * handoff needs its base commit and the copy lacks it, that one commit is fetched by SHA from the
 * repository the signed-in account was authorized for (`--depth=1`, no tags, no checkout). The
 * GitHub token is passed to git as an HTTP header through `GIT_CONFIG_*` variables of that one
 * child process, never on the command line, in a URL, or on disk.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { git } from '../workflow/approval'
import { minimalEnv } from '../verification/childEnv'

const SHA = /^[0-9a-f]{40}$/
const FULL_NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*$/

export interface RepoSource {
  /** The project's local git directory. Stable across restarts. */
  dir(projectId: string): string
  /**
   * Makes `sha` available in `dir(projectId)`, fetching it from `fullName` when missing.
   * Resolves to the directory; rejects if the commit cannot be obtained.
   */
  ensure(projectId: string, fullName: string, sha: string): Promise<string>
}

export interface GitMirrorOptions {
  root: string
  /** Clone URL of a repository, e.g. `https://github.com/<fullName>.git`. */
  remoteUrl(fullName: string): string
  /** `AUTHORIZATION: ...` header value for the remote, or null for a public or local remote. */
  authHeader?: () => Promise<string | null>
  /** The URL prefix the header applies to. */
  authScope?: string
}

export class GitMirror implements RepoSource {
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly options: GitMirrorOptions) {}

  dir(projectId: string): string {
    if (!/^[0-9]{1,20}$/.test(projectId)) throw new Error('Expected a project ID.')
    return join(this.options.root, `${projectId}.git`)
  }

  ensure(projectId: string, fullName: string, sha: string): Promise<string> {
    const dir = this.dir(projectId)
    if (!SHA.test(sha)) return Promise.reject(new Error(`${sha} is not a full commit SHA.`))
    if (!FULL_NAME.test(fullName))
      return Promise.reject(new Error(`${fullName} is not a repository name.`))
    const prior = this.locks.get(projectId) ?? Promise.resolve()
    const next = prior.then(() => this.fetch(dir, fullName, sha))
    this.locks.set(
      projectId,
      next.catch(() => undefined)
    )
    return next
  }

  private async fetch(dir: string, fullName: string, sha: string): Promise<string> {
    if (!existsSync(join(dir, 'HEAD'))) {
      mkdirSync(dir, { recursive: true })
      git(dir, ['init', '--bare', '-q'])
    }
    if (hasCommit(dir, sha)) return dir
    const header = (await this.options.authHeader?.()) ?? null
    const scope = this.options.authScope ?? 'https://github.com/'
    const env = minimalEnv(
      header
        ? {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: `http.${scope}.extraheader`,
            GIT_CONFIG_VALUE_0: header
          }
        : {}
    )
    const url = this.options.remoteUrl(fullName)
    await new Promise<void>((resolve, reject) =>
      execFile(
        'git',
        ['fetch', '--quiet', '--no-tags', '--depth=1', '--', url, sha],
        { cwd: dir, env, timeout: 300_000, maxBuffer: 1 << 20 },
        (error, _stdout, stderr) =>
          error
            ? reject(new Error(`Could not fetch ${sha} from ${fullName}: ${String(stderr).trim()}`))
            : resolve()
      )
    )
    if (!hasCommit(dir, sha)) throw new Error(`${fullName} has no commit ${sha}.`)
    // Pin it so a later gc keeps the base of every approval.
    git(dir, ['update-ref', `refs/diogenes/base/${sha}`, sha])
    return dir
  }
}

function hasCommit(dir: string, sha: string): boolean {
  try {
    return git(dir, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).trim() === sha
  } catch {
    return false
  }
}

const BRANCH = /^diogenes\/[a-z0-9][a-z0-9-]{0,62}$/

/**
 * Pushes one commit to a new branch, without force: an existing branch at another commit is
 * rejected by the remote. `authHeader` reaches only this git process, as in `GitMirror`.
 */
export async function pushBranch(input: {
  gitDir: string
  url: string
  sha: string
  branch: string
  authHeader?: string | null
  authScope?: string
}): Promise<void> {
  const { gitDir, url, sha, branch, authHeader } = input
  if (!SHA.test(sha)) throw new Error(`${sha} is not a full commit SHA.`)
  if (!BRANCH.test(branch)) throw new Error(`${branch} is not a Diogenes review branch.`)
  const scope = input.authScope ?? 'https://github.com/'
  const env = minimalEnv(
    authHeader
      ? {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `http.${scope}.extraheader`,
          GIT_CONFIG_VALUE_0: authHeader
        }
      : {}
  )
  await new Promise<void>((resolve, reject) =>
    execFile(
      'git',
      ['push', '--quiet', '--no-verify', '--', url, `${sha}:refs/heads/${branch}`],
      { cwd: gitDir, env, timeout: 300_000, maxBuffer: 1 << 20 },
      (error, _stdout, stderr) =>
        error ? reject(new Error(`Could not push ${branch}: ${String(stderr).trim()}`)) : resolve()
    )
  )
}
