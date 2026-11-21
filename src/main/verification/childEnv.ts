/**
 * Explicit, minimal environments for child processes that touch candidate-derived code or files.
 * Nothing is inherited wholesale, so database URLs and passwords, Gemini keys and GitHub tokens
 * in the main process never reach a candidate's caller, the compiler, Bend or git.
 */
const ALLOWED = ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT'] as const

export function minimalEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ALLOWED) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value
  // git must not read user or system config (aliases, hooks paths, credential helpers).
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}
