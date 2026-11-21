/** A Claude Code session running on this machine, from `claude agents --json`. */
export interface ClaudeAgent {
  sessionId: string
  name: string
  /** The folder it works in. */
  cwd: string
  kind: 'interactive' | 'background'
  /** As Claude reports it: idle, busy, working, blocked… */
  status: string
  /** Its folder is a checkout of the project's GitHub repository. */
  inRepo: boolean
}

export interface ClaudeSendResult {
  /** Short id for `claude attach <id>`, when Claude printed one. */
  id: string | null
  cwd: string
  /** What `claude --bg` printed. */
  output: string
}
