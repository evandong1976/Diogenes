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

## Design agent harness

`DesignService` ([src/main/design/harness.ts](../src/main/design/harness.ts)) runs design turns in the main process with no Electron dependency, so a headless client or a test can drive it. Types are in [src/shared/design.ts](../src/shared/design.ts). `createDesignService` in [src/main/design/index.ts](../src/main/design/index.ts) wires the indexed catalog, GitHub source at the draft commit, and the standard Gemini API. Nothing is on IPC yet.

| Entry point                                        | Effect                                                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `openProject(projectId, repositoryId)`             | Creates the working draft from the observed catalog (revision 0) on first open. Returns `ProjectState`.                                       |
| `getProject(projectId)`                            | Draft, proposals, approved intents, correction requests, and turns. Turns left `running` by a previous process are reported as `interrupted`. |
| `startTurn(DesignTurnInput)`                       | Runs one turn against the exact `GraphRef`. Returns a `TurnRecord`: `awaiting-approval`, `completed`, `stale-graph`, `cancelled` or `failed`. |
| `cancelTurn(turnId)`                               | Aborts a running turn. The draft is unchanged.                                                                                                |
| `approve(projectId, proposalId, expectedRevision)` | Stages a pending proposal when the draft is still at its base revision. Idempotent. Returns the new draft and the frozen `ApprovedIntent`.    |
| `reject(projectId, proposalId, reason?)`           | Marks a pending proposal rejected.                                                                                                            |
| `getIntent(projectId, intentId)`                   | The approved intent to hand to a coding run.                                                                                                  |

The model sees these tools. All run locally against the draft the turn was given.

| Tool                 | Effect                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `inspect_component`  | A component's kind, ports, cited sources, and direct connections.                                                            |
| `follow_connections` | Connections and components up to 3 hops in, out, or both.                                                                    |
| `read_source`        | The cited source excerpt at the draft commit. It is recorded as evidence and returns an `evidenceId`.                        |
| `propose_graph_edit` | Validates a `CatalogPatch` with `applyCatalogPatch`. It records a pending proposal with a preview, or returns the rejection. |
| `read_verification`  | The latest `VerificationReport` for an approved intent in the thread.                                                        |
| `request_correction` | Records a `CorrectionRequest` against a failed verification. The intent is unchanged.                                        |

The harness, not the model, sets the patch's repository, commit and base revision. Each turn is capped at 8 model steps and 16 tool calls. Earlier turns replay as plain text, so a thread can switch models. Within a turn, model parts, including thought signatures, are returned verbatim. `pnpm vitest run test/design` exercises the loop with a scripted model and the real graph editor.

### Managed coding runs (main process, not yet on the bridge)

`createCodingRunGateway({ dataDir })` in [src/main/coding](../src/main/coding/index.ts) returns a `CodingRunApi` ([types](../src/shared/codingRun.ts)). It turns an approved `CodingHandoff` and its in-scope sources at `baseCommit` into one durable Antigravity session.

| Call                        | Effect                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `start({ handoff, files })` | Validates scope and inline limits, persists the run, returns `runId` with phase `starting`, then creates the interaction.          |
| `status(runId)`             | Refreshes a `running` turn from the provider, then downloads and checks the turn's candidate.                                      |
| `reopen(runId)`             | After a restart: an unanswered create becomes `uncertain`, a running turn is refreshed, an idle environment is checked for expiry. |
| `followUp(runId, message)`  | Only when `idle`. Sends `previous_interaction_id` and the same `environment` ID, so the agent keeps its conversation and files.    |
| `retry(runId)`              | Only when `uncertain`. Resends the latest turn and records another entry in `turn.attempts`. Nothing is resent automatically.      |
| `list()`                    | Persisted runs with phase and candidate status, newest first.                                                                      |

The agent must end each turn by running the staged `export-candidate.mjs` with that turn's token. It writes a `git diff --binary` against the staged base, with sha256 and source digest, to `/workspace/.diogenes/out/candidate.json`, which the gateway downloads through the Environments files API. `candidate.status` is `ready` only when the token, source digest, checksum and scope all match. Apply it with `git apply --index` on a clean checkout of `baseCommit`. Runs live under `<dataDir>/coding-runs/<runId>/`. `pnpm vitest run test/coding` exercises the lifecycle against a fake provider.

## Proposed tools

These are ownership targets for teammates. Add a callable name here when its interface exists.

| Tool                | Purpose                                                                | Expected behavior                                               |
| ------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| Inspect component   | Show a selected component, its neighbors, and its code references.     | Reads the current graph.                                        |
| Apply approved edit | Update the canvas with a reviewed change.                              | Changes the working diagram after the user accepts the preview. |
| Export agent brief  | Package the approved change, source references, and acceptance checks. | Produces a Markdown handoff for a coding agent.                 |
| Verify behavior     | Run a specific acceptance check against the implementation.            | Reports the check, observed result, and pass or fail.           |

## Approval, coding handoff and verification

`window.api.workflow` exposes the headless workflow: `preview`, `approve`, `startHandoff`, `refresh`, `steer`, `cancel`, `requestCorrection`, `resolveDecision`, `getHandoff`, `getProject`. See [Workflow](workflow.md) for identities, lifecycle, what each service implements, and where local guarantees end. Until the coding gateway and design thread are wired in, `startHandoff` rejects and results are queryable only through `getProject`.

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

| Tool               | Purpose                                                                | Expected behavior                                     |
| ------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| Export agent brief | Package the approved change, source references, and acceptance checks. | Produces a Markdown handoff for a coding agent.       |
| Verify behavior    | Run a specific acceptance check against the implementation.            | Reports the check, observed result, and pass or fail. |
