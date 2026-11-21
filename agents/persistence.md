# Integrated backend and persistence

Entry points: [src/main/backend/backend.ts](../src/main/backend/backend.ts) (`createBackend`, Electron-free, usable headless) and [src/main/backend/ipc.ts](../src/main/backend/ipc.ts) (Electron). Contract: [src/shared/backend.ts](../src/shared/backend.ts). Bridge: `window.api.backend`. `window.api.workflow` is the same object as `window.api.backend.workflow`.

## Wiring

| Piece                                                     | Implemented by                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Design conversation history                               | `StoredThreadHistory` over the thread store                                        |
| Workflow results posted to the thread                     | `StoredWorkflowSink`: `reference` events with handoff/run/verdict refs             |
| Workflow `CodingGateway`                                  | `ManagedCodingAdapter` over `CodingRunGateway` (Antigravity)                       |
| Design `read_verification`                                | The latest local verdict of the intent's handoff. `unknown` stays `unknown`        |
| Design `request_correction`                               | Forwarded to `requestCorrection` on the same handoff                               |
| `design.approve(projectId, proposalId, expectedRevision)` | Draft revision check, then the frozen workflow approval. Both steps are idempotent |

## Authorization

Every call names a `projectId` (the GitHub repository ID). The main process checks that the signed-in GitHub account can read that repository (`getAuthorizedRepo`), then looks up every other ID inside that project. IDs from another project are reported as not found. The approver recorded on an approval is the verified GitHub login, never a value from the renderer.

## Storage

With `DIOGENES_DATABASE_URL` set, all state is in Postgres and there is no fallback. If the database is unreachable or unmigrated, every backend call rejects. Without it, the file stores under `<userData>/backend/` are used.

- TLS must be `sslmode=verify-full` with a root CA (`sslrootcert` or `PGSSLROOTCERT`). The URL and password stay in the main process.
- Migrations live in `src/main/persistence/migrations/`. They are versioned and additive, run under an advisory lock, and are recorded in `private.dg_schema_migrations`. The app applies pending ones at start. The Supabase CLI history is not touched.
- Tables are `private.dg_*`: threads and events, design project documents, approvals (immutable, `approval_id = sha256(packet_bytes)` enforced), handoffs, coding runs (frozen input, plus environment and last interaction IDs), and append-only candidates and verdicts. RLS is on with no policies, and `anon`/`authenticated` have no privileges.
- Candidate git objects stay in the local bare repo under `dataDir`. The database keeps the candidate record and commit SHA.

Child processes that touch candidate code (tsc, the refund driver, Bend, git) get an explicit minimal environment from [childEnv.ts](../src/main/verification/childEnv.ts).

## Check

```sh
pnpm smoke:db   # needs DIOGENES_DATABASE_URL; skipped otherwise
```

It writes one synthetic project (`9000000xxxxxx`), then a fresh process recovers every record and repeats the approval and an append to show they deduplicate.
