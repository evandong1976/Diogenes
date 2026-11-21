import type { IndexStatus } from '../../../shared/indexing'

export const indexRunning = (status: IndexStatus | null): boolean => status?.state === 'running'

/** One line for the status bar. */
export function indexLabel(status: IndexStatus | null): string {
  if (!status) return 'Index: not started'
  const last = status.lastIndexed
  const done = last
    ? `Indexed ${last.sha.slice(0, 7)} · ${last.coverage.nodes} nodes${last.state === 'partial' ? ' (partial)' : ''}`
    : null
  switch (status.state) {
    case 'running':
      return `Indexing… ${status.stage ?? ''}`.trim()
    case 'failed':
      return done ? `${done} · refresh failed` : `Index failed: ${status.error ?? 'unknown error'}`
    case 'idle':
      return done ?? 'Index: not started'
    default:
      return done ?? 'Indexed'
  }
}
