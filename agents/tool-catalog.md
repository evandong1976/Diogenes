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

`window.api.catalog.preview(patch)` validates ordered catalog operations against the authorized, observed snapshot and returns a new draft graph or a structured rejection. It leaves the observed snapshot on disk intact. To preview several edits, submit the combined operation list against the observed revision. The renderer uses this bridge to preview adding components, unlinking connections and deleting components. The same contract can be used by an agent tool that proposes catalog edits.

## Managed coding agent

`window.api.gemini.runManagedRetry(graph, proposal)` runs after the user approves a retry-once edit on the bundled background-job example. The main process sends the validated edit and bundled fixture to Antigravity with Gemini 4 Carbon. It returns the remote acceptance checks and diff through the preload bridge. [Fixture verification](../fixtures/background-job/verify-retry.mjs).

## Proposed tools

These are ownership targets for teammates. Add a callable name here when its interface exists.

| Tool                | Purpose                                                                | Expected behavior                                               |
| ------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| Inspect component   | Show a selected component, its neighbors, and its code references.     | Reads the current graph.                                        |
| Apply approved edit | Update the canvas with a reviewed change.                              | Changes the working diagram after the user accepts the preview. |
| Export agent brief  | Package the approved change, source references, and acceptance checks. | Produces a Markdown handoff for a coding agent.                 |
| Verify behavior     | Run a specific acceptance check against the implementation.            | Reports the check, observed result, and pass or fail.           |

## Project threads (main process)

`ThreadStore` in [src/main/threads/store.ts](../src/main/threads/store.ts) keeps design and coding conversations so a project can be reopened after a restart. Types are in [src/shared/threads.ts](../src/shared/threads.ts). It is not on the preload bridge yet. Services in `src/main` call it directly, and the shared app wiring (IPC, `<userData>/threads` root, single-instance lock) is pending.

| Call                                                        | Return            | Effect                                                                                                                    |
| ----------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `create(projectId, { kind, title?, id? })`                  | `ThreadSummary`   | New `design` or `coding` thread with a stable `thr_` ID. Re-creating the same ID and kind returns it unchanged.           |
| `list(projectId, { kind? })`                                | `ThreadSummary[]` | Threads in one project, most recently updated first.                                                                      |
| `open(projectId, threadId)`                                 | `ThreadSnapshot`  | Ordered events plus provider state. This is enough to restore a conversation without calling Gemini.                      |
| `append(projectId, threadId, events, { expectedLastSeq? })` | `AppendResult`    | Appends one or more events as a single atomic write.                                                                      |
| `eventsSince(projectId, threadId, afterSeq)`                | `ThreadEvent[]`   | Events after a known `lastSeq`.                                                                                           |
| `setProvider(projectId, threadId, state \| null)`           | `ThreadSummary`   | Replaces Gemini continuation metadata (`model`, `interactionId`, `environmentId`, `status`). The transcript is unchanged. |
| `subscribe(listener)`                                       | Unsubscribe       | Delivers a `ThreadChange` after every committed write.                                                                    |

Events are `user_message` (with optional `context.selectedComponentIds`), `assistant_message`, `tool_call`, `tool_result` and `reference`. Any event can carry `refs` to a `draftRevision`, `proposal`, `handoff`, `codingRun` or `verdict`. The store only saves these references. The owning service reports the latest state of each object.

**Storage.** Each thread is one file at `<root>/<projectId>/<threadId>.json`. Every change re-reads the file, then writes a temp file, fsyncs it and renames it over the original. A restart therefore sees either the previous or the next complete version, never a partial write.

**Retries.** Pass an event `id`. Appending the same `id` with identical content returns the stored event with `duplicate: true`, even if other events were appended since. The same `id` with different content is rejected with `conflict`. Events without an `id` get a generated one and are never deduplicated.

**Two writers.** Writes to one thread are queued within the process. Concurrent appends all land, in arrival order, with gapless `seq`. A writer that must not interleave passes `expectedLastSeq` and gets `stale` if the thread moved. Only one store may use a root, and Electron's single-instance lock (scoped to `userData`) enforces that.

**Following a thread.** Call `open()`, remember `lastSeq`, then use `subscribe()` for pushes, or `eventsSince(lastSeq)` after a reconnect.

Run `pnpm vitest run test/threads` to check it.
