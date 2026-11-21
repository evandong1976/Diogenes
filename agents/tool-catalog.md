# Tool catalog

## Available in the Gemini backend

| Tool                                        | Input                         | Return           | Effect                                                                          |
| ------------------------------------------- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `window.api.gemini.buildCurrentGraph()`     | Bundled background-job source | `CurrentGraph`   | Hydrogen reads the fixture and returns its graph.                               |
| `window.api.gemini.proposeEdit(graph, png)` | Graph and PNG bytes           | `ProposalResult` | Carbon interprets the markup and returns a preview or a clarification question. |

Both run through the [typed preload bridge](../src/preload/index.ts) and use [main-process Gemini handlers](../src/main/gemini/ipc.ts). They make API requests and return data. The canvas owns accepting an edit. The graph builder currently reads two bundled files, so its output references `job.ts` and `worker.ts` relative to the [fixture source folder](../fixtures/background-job/source).

For `kind: 'edit'`, preview the replacement on a copy of the graph. Remove the transition identified by `replaceTransitionId` and append `addStates` and `addTransitions`. For `kind: 'clarification'`, display `question` and let the user revise the markup. Both calls can reject on invalid input, invalid output, or an API failure.

## Repository indexing

| Tool                                     | Input                | Return                  | Effect                                                                                  |
| ---------------------------------------- | -------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `window.api.indexing.start(repoId)`      | GitHub repository ID | `IndexStatus`           | Indexes the default branch at its current SHA, reusing a cached graph for the same SHA. |
| `window.api.indexing.retry(repoId)`      | GitHub repository ID | `IndexStatus`           | Same, ignoring the cache.                                                               |
| `window.api.indexing.getStatus(repoId)`  | GitHub repository ID | `IndexStatus`           | Running, complete, partial or failed, plus the last published SHA and coverage.         |
| `window.api.indexing.getGraph(repoId)`   | GitHub repository ID | `SoftwareGraph \| null` | The last published source graph. A failed refresh leaves it in place.                   |
| `window.api.indexing.onStatus(listener)` | Callback             | Unsubscribe function    | Status pushes while a job runs.                                                         |

Types are in [src/shared/indexing.ts](../src/shared/indexing.ts). The main process checks every repo ID against the current GitHub session before downloading source or serving a cached graph. It downloads the tarball for the exact commit, and a forked worker runs the pinned `@sourcegraph/scip-typescript` plus a TypeScript AST pass for imports, calls and callback arguments. Nothing is installed and no repository scripts run, so imports of packages show up as `unresolved` with reason `dependency-not-installed` and are listed in `coverage.missingDependencies`. Artifacts (`index.scip`, `graph.json`, `meta.json`) live under `<userData>/indexes/<repoId>/<sha>-<analyzerConfigKey>/`. Positions are 0-based with UTF-16 characters. `pnpm test` runs the [alias/barrel fixture](../test/fixtures/ts-alias-barrel) through the pipeline and service.

## Repository catalog

`window.api.indexing.getGraph(repoId)` includes a derived `catalog` for snapshots produced by this version of the indexer. The catalog exposes component types, source spans and typed connections at the indexed SHA. Refresh older snapshots to populate it.

`window.api.catalog.preview(patch)` validates ordered catalog operations against the authorized, observed snapshot and returns a new draft graph or a structured rejection. It leaves the observed snapshot on disk intact. To preview several edits, submit the combined operation list against the observed revision. The renderer uses this bridge for component creation and deletion previews. The same contract can be used by an agent tool that proposes catalog edits.

## Proposed tools

These are ownership targets for teammates. Add a callable name here when its interface exists.

| Tool                | Purpose                                                                | Expected behavior                                               |
| ------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| Inspect component   | Show a selected component, its neighbors, and its code references.     | Reads the current graph.                                        |
| Apply approved edit | Update the canvas with a reviewed change.                              | Changes the working diagram after the user accepts the preview. |
| Export agent brief  | Package the approved change, source references, and acceptance checks. | Produces a Markdown handoff for a coding agent.                 |
| Verify behavior     | Run a specific acceptance check against the implementation.            | Reports the check, observed result, and pass or fail.           |
