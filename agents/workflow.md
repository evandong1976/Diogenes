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
- **Coding gateway (Session 3)**: `CodingGateway`. Echo `handoffId`, `approvalId` and `baseCommit` in every snapshot and bundle. Return full file contents from the environment files API. Paths outside `editableRoot` cause the candidate to be rejected. See the doc comment in the contract for how Interactions API statuses and steering map onto it.

## Lifecycle

`coding → verifying → accepted | correctable | needs-decision → closed`.

- A run's `completed` status only means a candidate is ready to collect.
- Acceptance requires every obligation to `pass`.
- Any `fail` with attempts left makes the handoff `correctable`.
- A `fail` with no attempts left, any `unknown`, a rejected candidate, or a failed run moves it to `needs-decision`.
- `refresh(handoffId)` advances one step. Call it after a restart to resume runs that were in flight.

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

Only one change shape can be approved today: a single `update` to a `stateMachine` with a `behavior` payload, bound by a committed `<root>/catalog.json`.

## Reproducible check

```sh
DIOGENES_BEND=/path/to/bend-2.0.40/bin/bend BENDTT=/path/to/bendtt pnpm vitest run test/workflow
```

The proof-backed flow is skipped unless Bend 2.0.40 and `$BENDTT` are present. The unavailable-evidence and candidate-identity tests always run.
