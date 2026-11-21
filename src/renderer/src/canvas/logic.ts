import type {
  CurrentGraph,
  ManagedAgentResult,
  ProposedEdit,
  RepoRef
} from '../../../shared/gemini'
import type { IndexStatus } from '../../../shared/indexing'
import example from '../../../../fixtures/background-job/example.json'

// Saved Gemini responses, so the canvas works without an API key.
export const exampleGraph = example.currentGraph as CurrentGraph
export const exampleEdit = example.proposedEdit as ProposedEdit

export interface LogicState {
  graph: CurrentGraph
  /** Where the graph came from, shown in the toolbar. */
  source: string
  isExample: boolean
  /** The indexed catalog state machine the graph was loaded from, so chat can name it. */
  machine?: { id: string; name: string }
  /**
   * Edits approved since the graph was loaded, for the managed agent: `graph` is the graph before
   * the first of them, and `repo` is set when the graph came from a repo rather than the example.
   */
  approved?: { graph: CurrentGraph; edits: ProposedEdit[]; repo?: RepoRef }
  managed?:
    | { kind: 'running' }
    | { kind: 'done'; result: ManagedAgentResult }
    | { kind: 'error'; message: string }
  /** Bumped on every change so the view refits. */
  version: number
  /** Repo ID whose state machine was already built automatically, so it runs once per repo. */
  autoBuiltFor?: number
}

/**
 * Whether Code logic should build the open repo's state machine now: once per repo, after
 * indexing settles (finished or failed, so the index can rank files), and only while the
 * untouched example is showing, so nothing the user loaded or edited is replaced.
 */
export function shouldAutoBuild(
  repoId: number | undefined,
  logic: LogicState,
  indexState: IndexStatus['state'] | undefined
): boolean {
  return (
    repoId !== undefined &&
    indexState !== undefined &&
    indexState !== 'running' &&
    logic.isExample &&
    logic.source === initialLogic.source &&
    logic.autoBuiltFor !== repoId
  )
}

export const initialLogic: LogicState = {
  graph: exampleGraph,
  source: 'Saved example · background job',
  isExample: true,
  version: 0
}
