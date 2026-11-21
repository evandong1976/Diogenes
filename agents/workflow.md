# Approval → coding → verification workflow

Contract: [src/shared/workflow.ts](../src/shared/workflow.ts). Service: [src/main/workflow/service.ts](../src/main/workflow/service.ts). Bridge: `window.api.workflow` (project-scoped, see [Persistence](persistence.md)).

## Identities

| ID            | Minted by      | Meaning                                                                       |
| ------------- | -------------- | ----------------------------------------------------------------------------- |
| `projectId`   | GitHub         | Repository ID as a string                                                     |
| `threadId`    | Design thread  | Copied into the approval, never minted here                                   |
| `draftId`     | Draft service  | Same                                                                          |
| `proposalId`  | Draft service  | Same                                                                          |
| `approvalId`  | Workflow       | SHA-256 of the frozen packet bytes. The verifier reports it as `packetDigest` |
| `handoffId`   | Workflow       | One coding effort against one approval. Corrections stay inside it            |
| `runId`       | Coding gateway | One managed run (one attempt)                                                 |
| `candidateId` | Workflow       | Commit SHA of the materialized candidate, parented on the frozen base         |

Approving the same proposal twice returns the same approval.

## What each service implements

- **Design thread (Session 1)**: `DesignThreadSink.post(threadId, ThreadMessage)`. On `kind: 'verdict'` with `correctable`, the agent explains `mismatches` and calls `requestCorrection(handoffId, { obligationIds, instructions })`. It may only name failing obligations, and there is a limit on attempts. On `kind: 'decision'`, bring the choice to the developer and call `resolveDecision`.
- **Draft service (Session 2)**: on approval, call `approve({ correlation, baseline, patch, approvedBy })`. `baseline` is the observed catalog at the base commit. `preview` uses the same rules as `catalog.preview`.
- **Coding gateway (Session 3)**: `CodingGateway`. Echo `handoffId`, `approvalId` and `baseCommit` in every snapshot and bundle. Return full file contents from the environment files API. Paths outside the handoff's `editable` scope cause the candidate to be rejected. See the doc comment in the contract for how Interactions API statuses and steering map onto it.

## Lifecycle

`coding → verifying → accepted | correctable | needs-decision → closed`.

- A run's `completed` status only means a candidate is ready to collect.
- Acceptance requires every obligation to `pass`.
- Any `fail` with attempts left makes the handoff `correctable`.
- A `fail` with no attempts left, any `unknown`, a rejected candidate, or a failed run moves it to `needs-decision`.
- `refresh(handoffId)` advances one step. Call it after a restart to resume runs that were in flight.
- `startHandoff` is idempotent per approval: while a handoff is open it is returned, not restarted.

## Reviewing and delivering a handoff (Coding tab)

- `briefPreview(projectId, approvalId)`: the Markdown `codingBrief` produces from the frozen packet, before a start.
- `briefs(projectId, handoffId)`: per attempt, `markdown` (the workflow's brief: `codingBrief` on a start, `steerBrief`/`correctionBrief` on a follow-up) and `submitted`, the exact provider input. Both are read back from the coding run's frozen input and the stored turn (`turnPrompt` in `src/main/coding/gateway.ts`), so they match what was sent, byte for byte, after a restart too. Brief wording belongs to `src/main/workflow/brief.ts`; the provider wrapper (workspace, shell note, export step) to `turnPrompt`.
- `candidateDiff(projectId, handoffId, attempt)`: `git show` of any materialized candidate, verified or not.
- `publishVerified(projectId, handoffId)`: pushes the newest locally verified candidate commit to `diogenes/verified-<sha12>` on the authorized repository, without force, with the session token as a header of that one git process. It refuses unverified candidates and the default branch, and records `published` on the handoff. The fallback is `verifiedPatch` plus a manual `git am`.
- Run events from shell activity carry `shell: 'command' | 'output'`.

## Repository and base commit

Approval, handoff and correction resolve the authorized repository from the project (GitHub authorization, not the renderer) and fetch the exact indexed commit by SHA into `<userData>/backend/repos/<projectId>.git` (`--depth=1`, pinned under `refs/diogenes/base/`). The GitHub token reaches that one git process as an HTTP header through `GIT_CONFIG_*`, with an otherwise minimal environment. No local clone has to be configured.

## Steering, corrections and cancellation

A managed run is one workspace (`environmentId`) with a chain of turns (`previous_interaction_id`). A completed turn leaves its workspace idle and reusable, so:

- `steer(handoffId, message)` is a follow-up turn in the same workspace once the current turn has ended (any open stage). The new turn is a new attempt with its own candidate and verdict; steers do not count toward the correction limit.
- `requestCorrection` also continues the same workspace when it is still available, and starts a fresh run only when it has expired (environments idle out after 15 minutes and are kept for 7 days).
- Continuation references (`environmentId` and each turn's `interactionId`) are persisted, so both work after a restart.
- A candidate is only collected from the latest turn.
- `cancel(handoffId)` calls the provider's cancel and reads the turn back. `cancellation.outcome` is `confirmed` (provider reports `cancelled`), `requested` (still stopping), `finished` (the turn had already ended), `not-running`, or `unconfirmed` (the cancel call failed and the turn may still be running).
- Retrying is never automatic. `retry-run` and `coding.retry` are refused while the remote turn may still be working; a resend after an unknown create is marked `mayDuplicate`, because the Interactions API has no idempotency key.

State lives in Postgres when `DIOGENES_DATABASE_URL` is set (see [Persistence](persistence.md)). Otherwise it is in `<userData>/backend/workflow/`:

- `state.json`
- `approvals/<approvalId>.json`: the exact packet bytes (with a database, a verified cache of them)
- `candidates/<projectId>.git`: a bare repo that borrows the project's objects through git alternates and pins candidates under `refs/candidates/`

## Local obligations (refund retry verifier)

Each obligation result names the approval, the candidate, the tool and the target.

| Obligation          | Guarantees                                                                                                                                              | Does not cover                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `native-typecheck`  | The caller and reducer types compile under a strict config the verifier owns                                                                            | Any behavior                                                                                                            |
| `graph-conformance` | The compiled reducer matches the approved table on every state/event pair (6 × 7). The caller forwards exactly the emitted attempts on two fixed traces | Other caller traces, real payment I/O, concurrency, idempotency                                                         |
| `bend-law`          | BendTT accepts the candidate's proof that `step` equals the approved function over the generated finite domain                                          | Anything outside `step`. Attempt numbers are fixed to 1–3, so a fourth execution shows up as a repeated `RunAttempt(3)` |

`unknown` always carries one of three `unknownReason` values:

- `unavailable`: the pinned Bend is missing, or BendTT has no kernel. Install it, then resolve the decision with `reverify`.
- `inconclusive`: the tool ran but reached no verdict.
- `unsupported`: no verifier is registered for the packet's `toolchain.verifier`.

The refund packet is used for a single `update` to a `stateMachine` with a `behavior` payload, bound by a committed `<root>/catalog.json`. Every other valid catalog patch is frozen as a catalog packet.

## Local obligations (catalog verifier, `diogenes-catalog-v1`)

The packet (`kind: 'catalog'`) lists the connections a candidate must add, remove and keep, the editable `scope` (directories of the touched components' source), and the base source handed to the agent. The verifier checks the candidate is one commit on the base inside the scope, then materializes base and candidate from git into a scratch directory (no install, no scripts).

| Obligation            | Guarantees                                                                                                                    | Does not cover                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `native-typecheck`    | The TypeScript compiler (repo `tsconfig.json`, noEmit) reports no diagnostic the base did not already have                    | Behavior. Dependencies are not installed, so unresolved imports count only if they are new         |
| `catalog-conformance` | Re-indexing the candidate with the same pipeline shows each required connection added or removed, and each preserved one kept | Anything the indexer cannot observe. Node changes and connections to proposed nodes stay `unknown` |
| `bend-law`            | Present only when a state machine behavior changed; `unknown` (`unsupported`) because no proof binding exists for it          | The behavior                                                                                       |

An expectation the re-indexed base already satisfies is not evidence and is `unknown`. Declaring port contracts or data contract nodes is recorded as `annotations` and asks nothing of the code. Acceptance needs every obligation to pass.

## Reproducible check

```sh
DIOGENES_BEND=/path/to/bend-2.0.40/bin/bend BENDTT=/path/to/bendtt pnpm vitest run test/workflow
```

`test/workflow/catalogFlow.test.ts` runs a rewire end to end (approval, handoff, a candidate that compiles but misses the connection, a steered fix, persisted verdicts, restart, cancel) with only provider calls faked.

The proof-backed flow is skipped unless Bend 2.0.40 and `$BENDTT` are present. The unavailable-evidence and candidate-identity tests always run.
