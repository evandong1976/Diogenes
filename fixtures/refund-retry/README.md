# Refund retry fixture

A manually bound state machine for checking a graph edit against a candidate commit. It makes no payment requests.

- `reducer.bend` is the pure retry decision (`step`). `domain.bend` holds the shared state, event and effect types.
- `retry.ts` (`createRefundRetry`) runs events through the generated reducer module and forwards `RunAttempt` commands to a sink. `reducer.d.mts` types that module.
- `catalog.json` is the catalog binding at this commit. The verifier adds the commit SHA, since a commit cannot name itself.

The approved change and its digest live in `../refund-retry-approval/`. Run the verifier with `node scripts/verify-refund-retry.ts`.
