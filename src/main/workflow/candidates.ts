/**
 * Candidate workspace: a bare repository under the workflow store that borrows the project's
 * objects through git alternates. Candidates become commits on the frozen base here, so the
 * developer's worktree, index and refs are never touched and candidates survive a restart.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, posix, resolve } from 'node:path'
import { git } from './approval.ts'
import { minimalEnv } from '../verification/childEnv.ts'
import type { CandidateBundle, CodingHandoff } from '../../shared/workflow'

export class CandidateRepo {
  constructor(
    readonly dir: string,
    private readonly sourceRepo: string
  ) {}

  ensure(): void {
    if (!existsSync(join(this.dir, 'HEAD'))) {
      mkdirSync(this.dir, { recursive: true })
      git(this.dir, ['init', '--bare', '-q'])
    }
    const common = git(this.sourceRepo, ['rev-parse', '--git-common-dir']).trim()
    const objects = resolve(this.sourceRepo, common, 'objects')
    writeFileSync(join(this.dir, 'objects', 'info', 'alternates'), `${objects}\n`)
  }

  /** Why the bundle cannot be this handoff's candidate, or undefined when it can. */
  check(
    bundle: CandidateBundle,
    expected: Pick<CodingHandoff, 'handoffId' | 'approvalId' | 'baseCommit' | 'editableRoot'> & {
      runId: string
    }
  ): string | undefined {
    for (const key of ['runId', 'handoffId', 'approvalId', 'baseCommit'] as const)
      if (bundle[key] !== expected[key])
        return `Candidate ${key} ${bundle[key]} does not match the expected ${expected[key]}`
    if (!bundle.files.length && !bundle.deleted.length) return 'Candidate changes no files'
    const prefix = `${expected.editableRoot}/`
    for (const path of [...bundle.files.map((f) => f.path), ...bundle.deleted]) {
      if (isAbsolute(path) || posix.normalize(path) !== path || path.split('/').includes('..'))
        return `Candidate path ${path} is not a normalized repository path`
      if (!path.startsWith(prefix))
        return `Candidate changes ${path}, outside the approved ${expected.editableRoot}/`
    }
    return undefined
  }

  /** Commits the bundle over the base and pins it under refs/candidates/. Returns the SHA. */
  materialize(bundle: CandidateBundle, attempt: number): string {
    this.ensure()
    const tmp = mkdtempSync(join(this.dir, 'index-'))
    const env = minimalEnv({
      GIT_INDEX_FILE: join(tmp, 'index'),
      GIT_AUTHOR_NAME: 'Diogenes candidate',
      GIT_AUTHOR_EMAIL: 'candidate@diogenes.invalid',
      GIT_COMMITTER_NAME: 'Diogenes candidate',
      GIT_COMMITTER_EMAIL: 'candidate@diogenes.invalid'
    })
    const run = (args: string[], input?: string): string => git(this.dir, args, input, env).trim()
    try {
      run(['read-tree', bundle.baseCommit])
      for (const file of bundle.files) {
        const blob = run(['hash-object', '-w', '--stdin'], file.text)
        run(['update-index', '--add', '--cacheinfo', `100644,${blob},${file.path}`])
      }
      for (const path of bundle.deleted) run(['update-index', '--force-remove', path])
      const message = [
        `Candidate ${bundle.handoffId} attempt ${attempt}`,
        '',
        `Diogenes-Approval: ${bundle.approvalId}`,
        `Diogenes-Handoff: ${bundle.handoffId}`,
        `Diogenes-Run: ${bundle.runId}`
      ].join('\n')
      const sha = run([
        'commit-tree',
        '--no-gpg-sign',
        run(['write-tree']),
        '-p',
        bundle.baseCommit,
        '-m',
        message
      ])
      run(['update-ref', `refs/candidates/${bundle.handoffId}/${attempt}`, sha])
      return sha
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}
