import { createHash } from 'crypto'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  GRAPH_SCHEMA_VERSION,
  type AnalyzerInfo,
  type Diagnostic,
  type IndexStage,
  type SoftwareGraph
} from '../../shared/indexing'
import { deriveCatalog } from '../catalog/discovery'
import { buildGraph } from './graph'
import {
  loadTypescript,
  locateAnalyzers,
  planProjects,
  readScipIndex,
  writeEmptyScipIndex,
  runScipTypescript,
  scipKindNames,
  writeFallbackTsconfig
} from './scip'
import { DEFAULT_LIMITS, extractSnapshot, SnapshotError, type SnapshotLimits } from './snapshot'

/** Bumped whenever graph construction changes in a way that invalidates cached graphs. */
export const NORMALIZER_VERSION = '2'
const SCIP_TIMEOUT_MS = 15 * 60 * 1000

export type JobInput = {
  archivePath: string
  /** Scratch directory owned by this job; removed by the caller afterwards. */
  workDir: string
  /** Where the finished artifacts are written (index.scip, graph.json). */
  outDir: string
  repository: { id: number; fullName: string }
  commit: { sha: string; ref: string }
  limits?: SnapshotLimits
}

export type JobResult = { status: 'complete' | 'partial'; graphPath: string; scipPath: string }

export function analyzerInfo(): AnalyzerInfo[] {
  const a = locateAnalyzers()
  return [
    { name: 'scip-typescript', version: a.scipTypescript.version },
    {
      name: 'diogenes-ts-ast',
      version: NORMALIZER_VERSION,
      detail: { typescript: a.typescript.version }
    }
  ]
}

/** Cache key: same repo + commit + this key ⇒ the stored graph is reusable. */
export function analyzerConfigKey(limits: SnapshotLimits = DEFAULT_LIMITS): string {
  return createHash('sha256')
    .update(JSON.stringify({ schema: GRAPH_SCHEMA_VERSION, analyzers: analyzerInfo(), limits }))
    .digest('hex')
    .slice(0, 16)
}

export async function runIndexJob(
  input: JobInput,
  onStage: (stage: IndexStage) => void = () => {}
): Promise<JobResult> {
  const limits = input.limits ?? DEFAULT_LIMITS
  const src = join(input.workDir, 'src')
  await mkdir(src, { recursive: true })
  await mkdir(input.outDir, { recursive: true })
  const diagnostics: Diagnostic[] = []

  onStage('extracting')
  const snap = await extractSnapshot(input.archivePath, src, limits)
  const short = input.commit.sha.slice(0, 7)
  if (snap.archiveCommit && snap.archiveCommit !== input.commit.sha) {
    throw new SnapshotError(
      `Archive is for commit ${snap.archiveCommit}, expected ${input.commit.sha}.`
    )
  }
  if (!snap.archiveCommit && snap.rootDir && !snap.rootDir.endsWith(`-${short}`)) {
    diagnostics.push({
      severity: 'warning',
      code: 'archive-commit-unverified',
      message: `Archive root ${snap.rootDir} does not name commit ${short}.`
    })
  }

  onStage('indexing')
  const scipPath = join(input.outDir, 'index.scip')
  // A repo with no TypeScript/JavaScript (README-only, Python, …) gives scip-typescript nothing to
  // index, so it fails. Record an empty code index instead; manifests still feed the catalog.
  const hasScripts = snap.files.some(
    (f) => (f.language === 'typescript' || f.language === 'javascript') && f.reason !== 'too-large'
  )
  if (!hasScripts) {
    diagnostics.push({
      severity: 'info',
      code: 'no-typescript-sources',
      message: 'No TypeScript or JavaScript files to analyze; only manifests were read.'
    })
    await writeEmptyScipIndex(scipPath)
  } else {
    const plan = await planProjects(src)
    let run = await runScipTypescript({
      root: src,
      output: scipPath,
      projects: plan.projects,
      inferTsconfig: plan.infer,
      timeoutMs: SCIP_TIMEOUT_MS
    })
    const produced = async (): Promise<boolean> =>
      stat(scipPath).then(
        (s) => s.size > 0,
        () => false
      )
    if (!run.timedOut && !(await produced())) {
      // Commonly a tsconfig that `extends` an uninstalled package. Retry with a permissive config
      // so the source is still indexed; path aliases from the original config are lost.
      diagnostics.push({
        severity: 'warning',
        code: 'tsconfig-unusable',
        message: `scip-typescript indexed nothing with the repository's tsconfig; retried with a fallback config. Output: ${run.output.trim().slice(0, 2000)}`
      })
      const fallback = await writeFallbackTsconfig(src)
      run = await runScipTypescript({
        root: src,
        output: scipPath,
        projects: [fallback],
        inferTsconfig: false,
        timeoutMs: SCIP_TIMEOUT_MS
      })
    }
    if (run.timedOut) throw new Error('scip-typescript timed out.')
    if (!(await produced())) {
      throw new Error(`scip-typescript produced no index. ${run.output.trim().slice(0, 2000)}`)
    }
    if (run.exitCode !== 0 || /error/i.test(run.output)) {
      diagnostics.push({
        severity: run.exitCode === 0 ? 'info' : 'warning',
        code: 'scip-typescript-output',
        message: run.output.trim().slice(0, 4000)
      })
    }
  }

  onStage('analyzing')
  const index = await readScipIndex(scipPath)
  const graph: SoftwareGraph = await buildGraph({
    root: src,
    repository: input.repository,
    commit: input.commit,
    analyzers: analyzerInfo(),
    analyzerConfigKey: analyzerConfigKey(limits),
    files: snap.files,
    index,
    ts: loadTypescript(),
    kindNames: await scipKindNames(),
    diagnostics
  })

  const sourcePaths = new Set(
    snap.files
      .filter(({ status, reason }) => status !== 'rejected' && reason !== 'too-large')
      .map(({ path }) => path)
  )
  graph.catalog = await deriveCatalog(graph, async (path) => {
    if (!sourcePaths.has(path)) return null
    try {
      return await readFile(join(src, path), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  })

  onStage('saving')
  const graphPath = join(input.outDir, 'graph.json')
  await writeFile(graphPath, JSON.stringify(graph))
  return { status: graph.status, graphPath, scipPath }
}
