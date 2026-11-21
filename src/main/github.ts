import { app, ipcMain, safeStorage, shell } from 'electron'
import { readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import type { DeviceCode, GithubRepo, GithubUser, NewRepo } from '../preload'

const CLIENT_ID = import.meta.env.MAIN_VITE_GITHUB_CLIENT_ID
// Classic OAuth apps have no read-only scope for private repos, so `repo` it is.
const SCOPE = 'repo read:user'
const tokenPath = (): string => join(app.getPath('userData'), 'github-token')

let token: string | null = null
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

async function saveToken(value: string): Promise<void> {
  token = value
  await writeFile(tokenPath(), safeStorage.encryptString(value))
}

async function logout(): Promise<void> {
  token = null
  await rm(tokenPath(), { force: true })
}

/** GET by default; passing a body makes it a JSON POST. */
async function githubApi<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${await loadToken()}`,
      Accept: 'application/vnd.github+json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  if (res.status === 401) {
    await logout()
    throw new Error('GitHub session expired. Sign in again.')
  }
  if (!res.ok) {
    // GitHub explains 4xx failures, e.g. 422 "name already exists on this account".
    const err = (await res.json().catch(() => null)) as {
      message?: string
      errors?: { message?: string }[]
    } | null
    const detail = err?.errors?.[0]?.message ?? err?.message
    throw new Error(detail ? `GitHub: ${detail}` : `GitHub API ${res.status} on ${path}`)
  }
  return res.json() as Promise<T>
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

type RawRepo = {
  id: number
  full_name: string
  private: boolean
  description: string | null
  default_branch: string
  updated_at: string
}

const toRepo = (r: RawRepo): GithubRepo => ({
  id: r.id,
  fullName: r.full_name,
  private: r.private,
  description: r.description,
  defaultBranch: r.default_branch,
  updatedAt: r.updated_at
})

// ponytail: first 100 repos by recent activity; paginate via the Link header if users hit the cap.
async function listRepos(): Promise<GithubRepo[]> {
  const repos = await githubApi<RawRepo[]>(
    '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'
  )
  return repos.map(toRepo)
}

// Same rule GitHub applies; it would otherwise silently rewrite other characters to "-".
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/

// ponytail: personal account only; org owners need the read:org scope to list orgs.
async function createRepo(_e: unknown, input: NewRepo): Promise<GithubRepo> {
  const name = String(input?.name ?? '').trim()
  if (!REPO_NAME.test(name) || name === '.' || name === '..') {
    throw new Error('Use letters, numbers, ".", "-" or "_" (up to 100 characters).')
  }
  const repo = await githubApi<RawRepo>('/user/repos', {
    name,
    description: String(input.description ?? '').slice(0, 350) || undefined,
    private: input.private !== false,
    // An initial commit gives the repo a default branch, so it can be indexed and cloned right away.
    auto_init: true
  })
  return toRepo(repo)
}

export function registerGithubIpc(): void {
  ipcMain.handle('github:getUser', getUser)
  ipcMain.handle('github:startLogin', startLogin)
  ipcMain.handle('github:finishLogin', finishLogin)
  ipcMain.handle('github:logout', logout)
  ipcMain.handle('github:listRepos', listRepos)
  ipcMain.handle('github:createRepo', createRepo)
}
