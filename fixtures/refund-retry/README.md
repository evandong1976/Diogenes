# Refund retry fixture

A manually bound state machine for checking a graph edit against a candidate commit. It makes no payment requests.

- `reducer.bend` is the pure retry decision (`step`). `domain.bend` holds the shared state, event and effect types.
- `retry.ts` (`createRefundRetry`) runs events through the generated reducer module and forwards `RunAttempt` commands to a sink. `reducer.d.mts` types that module.
- `PROOF.bend` proves the verifier's generated `LAWS.bend` for this reducer.
- `catalog.json` is the catalog binding at the baseline commit 112de2f (two attempts). Approved behavior comes from the frozen patch, not this file.

The approved change and its digest live in `../refund-retry-approval/`. Run the verifier with `node scripts/verify-refund-retry.ts`.
