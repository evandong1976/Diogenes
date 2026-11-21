import { spawn } from 'child_process'
import { tmpdir } from 'os'
import { minimalEnv } from '../verification/childEnv'
import { existsSync, readFileSync, realpathSync } from 'fs'
import { readFile, readdir, writeFile } from 'fs/promises'
import { createRequire } from 'module'
import { dirname, join, relative } from 'path'
import type { Index } from '@scip-code/scip'

// Resolve packages relative to this module (CJS build) or the source file (tests).
const here = typeof __filename === 'string' ? __filename : import.meta.url
const req = createRequire(here)

export type Analyzers = {
  scipTypescript: { bin: string; version: string }
  /** The TypeScript compiler bundled with scip-typescript; the AST pass uses the same one. */
  typescript: { path: string; version: string }
}

let cached: Analyzers | null = null

/** Locates the pinned scip-typescript from the app's own dependencies (never a global install). */
export function locateAnalyzers(): Analyzers {
  if (cached) return cached
  const pkgJson = realpathSync(req.resolve('@sourcegraph/scip-typescript/package.json'))
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { version: string; bin: string }
  const scipDir = dirname(pkgJson)
  const tsReq = createRequire(pkgJson)
  const tsPath = tsReq.resolve('typescript')
  const tsVersion = (
    JSON.parse(readFileSync(tsReq.resolve('typescript/package.json'), 'utf8')) as {
      version: string
    }
  ).version
  cached = {
    scipTypescript: { bin: join(scipDir, pkg.bin), version: pkg.version },
    typescript: { path: tsPath, version: tsVersion }
  }
  return cached
}

export type TsModule = typeof import('typescript')

export function loadTypescript(): TsModule {
  return req(locateAnalyzers().typescript.path) as TsModule
}

export type ScipRun = { exitCode: number | null; output: string; timedOut: boolean }

/**
 * Runs scip-typescript as a child process. Never installs packages, runs builds,
 * or executes repository scripts: it only reads sources and tsconfig files.
 */
export function runScipTypescript(opts: {
  root: string
  output: string
  projects: string[]
  inferTsconfig: boolean
  timeoutMs: number
  signal?: AbortSignal
}): Promise<ScipRun> {
  const { bin } = locateAnalyzers().scipTypescript
  const args = [
    '--max-old-space-size=4096',
    bin,
    'index',
    '--cwd',
    opts.root,
    '--output',
    opts.output,
    '--no-progress-bar',
    ...(opts.inferTsconfig ? ['--infer-tsconfig'] : []),
    ...opts.projects
  ]
  // Indexed code is untrusted: the analyzer inherits no credentials (database, Gemini, GitHub).
  const env = minimalEnv({ ELECTRON_RUN_AS_NODE: '1', HOME: tmpdir() })
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: opts.root,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const append = (b: Buffer): void => {
      if (output.length < 64_000) output += b.toString('utf8')
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)
    const abort = (): void => {
      child.kill('SIGKILL')
    }
    opts.signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (e) => {
      clearTimeout(timer)
      rejectPromise(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', abort)
      resolvePromise({ exitCode: code, output, timedOut })
    })
  })
}

export async function readScipIndex(path: string): Promise<Index> {
  // Both packages are ESM-only; load them dynamically from the CJS build.
  const { fromBinary } = await import('@bufbuild/protobuf')
  const { IndexSchema } = await import('@scip-code/scip')
  return fromBinary(IndexSchema, await readFile(path))
}

export async function scipKindNames(): Promise<Record<number, string>> {
  const { SymbolInformation_Kind } = await import('@scip-code/scip')
  return SymbolInformation_Kind as unknown as Record<number, string>
}

/**
 * Decides which TypeScript projects to hand scip-typescript.
 * A root tsconfig.json wins; otherwise nested tsconfigs (monorepos); otherwise infer one.
 */
export async function planProjects(root: string): Promise<{ projects: string[]; infer: boolean }> {
  if (existsSync(join(root, 'tsconfig.json'))) return { projects: [], infer: false }
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || found.length >= 50) return
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue
      const sub = join(dir, e.name)
      if (existsSync(join(sub, 'tsconfig.json'))) found.push(relative(root, sub))
      else await walk(sub, depth + 1)
    }
  }
  await walk(root, 1)
  return found.length ? { projects: found.sort(), infer: false } : { projects: [], infer: true }
}

/** A permissive tsconfig used when the repo's own one cannot be loaded (e.g. `extends` an uninstalled package). */
export async function writeFallbackTsconfig(root: string): Promise<string> {
  const file = join(root, 'tsconfig.diogenes-fallback.json')
  await writeFile(
    file,
    JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        noEmit: true,
        jsx: 'preserve',
        skipLibCheck: true
      },
      include: ['**/*'],
      exclude: ['**/node_modules']
    })
  )
  return file
}
