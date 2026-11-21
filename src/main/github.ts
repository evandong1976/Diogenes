import { app, ipcMain, safeStorage, shell } from 'electron'
import { readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import type { DeviceCode, GithubRepo, GithubUser } from '../preload'

const CLIENT_ID = import.meta.env.MAIN_VITE_GITHUB_CLIENT_ID
// Classic OAuth apps have no read-only scope for private repos, so `repo` it is.
const SCOPE = 'repo read:user'
const tokenPath = (): string => join(app.getPath('userData'), 'github-token')

let token: string | null = null
// Bumped on every sign-in and sign-out so long-running work can tell the account changed.
let generation = 0
const sessionListeners = new Set<() => void>()
let pending: { deviceCode: string; interval: number; expiresAt: number } | null = null

async function loadToken(): Promise<string | null> {
  if (token) return token
  try {
    token = safeStorage.decryptString(await readFile(tokenPath()))
  } catch {
    token = null
  }
  return token
}

function sessionChanged(): void {
  generation++
  for (const l of sessionListeners) l()
}

async function saveToken(value: string): Promise<void> {
  token = value
  await writeFile(tokenPath(), safeStorage.encryptString(value))
  sessionChanged()
}

async function logout(): Promise<void> {
  token = null
  await rm(tokenPath(), { force: true })
  sessionChanged()
}

/** Identifies the current sign-in. Changes whenever the account signs in or out. */
export function sessionGeneration(): number {
  return generation
}

export function onSessionChange(listener: () => void): () => void {
  sessionListeners.add(listener)
  return () => sessionListeners.delete(listener)
}

/**
 * Authorized request to the GitHub REST API. The token never leaves the main process.
 * Returns the raw response so callers can stream bodies (tarballs) or read 404s.
 */
export async function githubFetch(
  path: string,
  init: { accept?: string; signal?: AbortSignal } = {}
): Promise<Response> {
  const current = await loadToken()
  if (!current) throw new Error('Not signed in to GitHub.')
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${current}`,
      Accept: init.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    signal: init.signal
  })
  if (res.status === 401) {
    await logout()
    throw new Error('GitHub session expired. Sign in again.')
  }
  return res
}

async function githubApi<T>(path: string): Promise<T> {
  const res = await githubFetch(path)
  if (!res.ok) throw new Error(`GitHub API ${res.status} on ${path}`)
  return res.json() as Promise<T>
}

export type AuthorizedRepo = { id: number; fullName: string; defaultBranch: string }

/**
 * Looks a repository up by numeric ID with the current session's token.
 * Null when the current account cannot read it (GitHub answers 404 for both cases).
 */
export async function getAuthorizedRepo(
  id: number,
  signal?: AbortSignal
): Promise<AuthorizedRepo | null> {
  const res = await githubFetch(`/repositories/${id}`, { signal })
  if (res.status === 404 || res.status === 403) return null
  if (!res.ok) throw new Error(`GitHub API ${res.status} looking up repository ${id}`)
  const r = (await res.json()) as {
    id: number
    full_name: string
    default_branch: string
    permissions?: { pull?: boolean }
  }
  if (r.id !== id || r.permissions?.pull === false) return null
  return { id: r.id, fullName: r.full_name, defaultBranch: r.default_branch }
}

type OAuthResponse = Partial<{
  device_code: string
  user_code: string
  verification_uri: string
  interval: number
  expires_in: number
  access_token: string
  error: string
  error_description: string
}>

async function oauthPost(path: string, body: Record<string, string>): Promise<OAuthResponse> {
  const res = await fetch(`https://github.com${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, ...body })
  })
  if (!res.ok) throw new Error(`GitHub OAuth ${res.status}`)
  return res.json()
}

async function getUser(): Promise<GithubUser | null> {
  if (!(await loadToken())) return null
  const u = await githubApi<{ login: string; name: string | null }>('/user')
  return { login: u.login, name: u.name }
}

async function startLogin(): Promise<DeviceCode> {
  if (!CLIENT_ID) throw new Error('MAIN_VITE_GITHUB_CLIENT_ID is not set. See README.')
  const r = await oauthPost('/login/device/code', { scope: SCOPE })
  if (!r.device_code || !r.user_code || !r.verification_uri) {
    throw new Error(r.error_description ?? 'GitHub did not return a sign-in code.')
  }
  pending = {
    deviceCode: r.device_code,
    interval: r.interval ?? 5,
    expiresAt: Date.now() + (r.expires_in ?? 900) * 1000
  }
  shell.openExternal(r.verification_uri)
  return { userCode: r.user_code, verificationUri: r.verification_uri }
}

// Polls until the user approves in the browser. A newer startLogin() supersedes this loop.
async function finishLogin(): Promise<GithubUser> {
  const flow = pending
  if (!flow) throw new Error('No sign-in in progress.')
  while (pending === flow && Date.now() < flow.expiresAt) {
    await new Promise((r) => setTimeout(r, flow.interval * 1000))
    const r = await oauthPost('/login/oauth/access_token', {
      device_code: flow.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    })
    if (r.access_token) {
      pending = null
      await saveToken(r.access_token)
      return (await getUser())!
    }
    if (r.error === 'slow_down') flow.interval = r.interval ?? flow.interval + 5
    else if (r.error !== 'authorization_pending') {
      pending = null
      throw new Error(r.error_description ?? r.error ?? 'Sign-in failed.')
    }
  }
  throw new Error(pending === flow ? 'Sign-in code expired. Try again.' : 'Sign-in was restarted.')
}

// ponytail: first 100 repos by recent activity; paginate via the Link header if users hit the cap.
async function listRepos(): Promise<GithubRepo[]> {
  const repos = await githubApi<
    {
      id: number
      full_name: string
      private: boolean
      description: string | null
      default_branch: string
      updated_at: string
    }[]
  >('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member')
  return repos.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    private: r.private,
    description: r.description,
    defaultBranch: r.default_branch,
    updatedAt: r.updated_at
  }))
}

export interface TreeFile {
  path: string
  size: number
}

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/')

/** Every file in the repo at `branch`. Large repos may come back truncated by GitHub. */
export async function getRepoTree(fullName: string, branch: string): Promise<TreeFile[]> {
  const tree = await githubApi<{ tree: { path: string; type: string; size?: number }[] }>(
    `/repos/${fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`
  )
  return tree.tree
    .filter((entry) => entry.type === 'blob')
    .map((entry) => ({ path: entry.path, size: entry.size ?? 0 }))
}

export async function getFileText(fullName: string, branch: string, path: string): Promise<string> {
  const res = await fetch(
    `https://api.github.com/repos/${fullName}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
    {
      headers: {
        Authorization: `Bearer ${await loadToken()}`,
        Accept: 'application/vnd.github.raw+json'
      }
    }
  )
  if (!res.ok) throw new Error(`GitHub API ${res.status} reading ${path}`)
  return res.text()
}

export function registerGithubIpc(): void {
  ipcMain.handle('github:getUser', getUser)
  ipcMain.handle('github:startLogin', startLogin)
  ipcMain.handle('github:finishLogin', finishLogin)
  ipcMain.handle('github:logout', logout)
  ipcMain.handle('github:listRepos', listRepos)
}
