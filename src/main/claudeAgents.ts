// Hands an approved change to a Claude Code agent running on this machine.
//
// Discovery is `claude agents --json` (interactive and background sessions). Sending uses
// `claude --bg --resume <sessionId> <prompt>`: an idle background session continues in place;
// a session that's open in a terminal gets a background copy with its full conversation, which
// `claude attach <id>` opens. There is no documented way to type into another terminal's session.
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { getAuthorizedRepo } from './github'
import type { ClaudeAgent, ClaudeSendResult } from '../shared/claudeAgents'

/** Electron launched from the Dock has a minimal PATH, so also look where installers put `claude`. */
function claudeBin(): string {
  const dirs = [
    ...(process.env.PATH ?? '').split(':'),
    join(homedir(), '.local/bin'),
    join(homedir(), '.claude/local'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  for (const dir of dirs) {
    if (dir && existsSync(join(dir, 'claude'))) return join(dir, 'claude')
  }
  return 'claude'
}

function run(
  file: string,
  args: string[],
  cwd?: string,
  timeout = 15_000
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout, maxBuffer: 4_000_000 }, (error, stdout, stderr) =>
      resolve({
        ok: !error,
        stdout: String(stdout),
        stderr: String(stderr || error?.message || '')
      })
    )
  })
}

type RawSession = {
  sessionId?: string
  id?: string
  name?: string
  cwd?: string
  kind?: string
  status?: string
  state?: string
  startedAt?: number
}

async function rawSessions(): Promise<RawSession[]> {
  const r = await run(claudeBin(), ['agents', '--json'])
  if (!r.ok)
    throw new Error(
      `Couldn't list Claude agents: ${r.stderr.trim() || 'is Claude Code installed?'}`
    )
  const parsed = JSON.parse(r.stdout) as unknown
  return Array.isArray(parsed) ? (parsed as RawSession[]) : []
}

/** `owner/repo` from an https or ssh remote URL, lowercased. */
function remoteRepo(url: string): string | null {
  const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return m ? m[1].toLowerCase() : null
}

async function listAgents(projectId: string): Promise<ClaudeAgent[]> {
  const [sessions, repo] = await Promise.all([
    rawSessions(),
    getAuthorizedRepo(Number(projectId)).catch(() => null)
  ])
  const want = repo?.fullName.toLowerCase()
  const agents = await Promise.all(
    sessions
      .filter((s) => s.sessionId && s.cwd)
      .map(async (s): Promise<ClaudeAgent> => {
        const remote = await run(
          'git',
          ['-C', s.cwd!, 'remote', 'get-url', 'origin'],
          undefined,
          5_000
        )
        return {
          sessionId: s.sessionId!,
          name: s.name ?? s.id ?? s.sessionId!.slice(0, 8),
          cwd: s.cwd!,
          kind: s.kind === 'background' ? 'background' : 'interactive',
          status: s.state ?? s.status ?? 'unknown',
          inRepo: !!want && remote.ok && remoteRepo(remote.stdout) === want
        }
      })
  )
  // Agents already in a checkout of this repository first.
  return agents.sort((a, b) => Number(b.inRepo) - Number(a.inRepo))
}

const MAX_PROMPT = 60_000

function checkPrompt(prompt: unknown): string {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Nothing to send.')
  if (prompt.length > MAX_PROMPT) throw new Error('The change is too long to send.')
  return prompt
}

/** The id `claude --bg` prints, for `claude attach <id>`. */
function startedId(output: string): string | null {
  return /\b([0-9a-f]{8})\b/.exec(output)?.[1] ?? null
}

async function sendToAgent(sessionId: unknown, prompt: unknown): Promise<ClaudeSendResult> {
  const text = checkPrompt(prompt)
  // The renderer names a session; its folder comes from Claude's own list, never from the UI.
  const session = (await rawSessions()).find((s) => s.sessionId === sessionId)
  if (!session?.cwd) throw new Error('That Claude agent is no longer running. Refresh the list.')
  const r = await run(
    claudeBin(),
    ['--bg', '--resume', session.sessionId!, text],
    session.cwd,
    60_000
  )
  if (!r.ok) throw new Error(r.stderr.trim() || 'Claude could not start the task.')
  const output = `${r.stdout}\n${r.stderr}`.trim()
  return { id: startedId(output), cwd: session.cwd, output }
}

async function sendToNewAgent(prompt: unknown): Promise<ClaudeSendResult | null> {
  const text = checkPrompt(prompt)
  const win = BrowserWindow.getFocusedWindow()
  const pick = await (win
    ? dialog.showOpenDialog(win, {
        title: 'Folder for the new Claude agent',
        message: 'Pick your local checkout of the repository',
        properties: ['openDirectory']
      })
    : dialog.showOpenDialog({ properties: ['openDirectory'] }))
  if (pick.canceled || !pick.filePaths[0]) return null
  const cwd = pick.filePaths[0]
  const r = await run(claudeBin(), ['--bg', text], cwd, 60_000)
  if (!r.ok) throw new Error(r.stderr.trim() || 'Claude could not start the task.')
  const output = `${r.stdout}\n${r.stderr}`.trim()
  return { id: startedId(output), cwd, output }
}

export function registerClaudeAgentsIpc(): void {
  ipcMain.handle('claude:listAgents', (_e, projectId: string) => listAgents(String(projectId)))
  ipcMain.handle('claude:send', (_e, sessionId: unknown, prompt: unknown) =>
    sendToAgent(sessionId, prompt)
  )
  ipcMain.handle('claude:sendNew', (_e, prompt: unknown) => sendToNewAgent(prompt))
}
