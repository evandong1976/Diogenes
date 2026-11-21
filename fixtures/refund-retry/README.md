# Refund retry fixture

A manually bound state machine for checking a graph edit against a candidate commit. It makes no payment requests.

- `reducer.bend` is the pure retry decision (`step`). `domain.bend` holds the shared state, event and effect types.
- `retry.ts` (`createRefundRetry`) runs events through the generated reducer module and forwards `RunAttempt` commands to a sink. `reducer.d.mts` types that module.
- `PROOF.bend` proves the verifier's generated `LAWS.bend` for this reducer.
- `catalog.json` is the catalog binding at the baseline commit 112de2f (two attempts). Approved behavior comes from the frozen patch, not this file.

The approved change and its digest live in `../refund-retry-approval/`. From the repository root, verify a candidate commit after installing the project dependencies and Bend 2.0.40 with BendTT:

```sh
node --experimental-transform-types scripts/verify-refund-retry.ts 195cf32
```

Use `DIOGENES_BEND` to select the Bend binary and `BENDTT` to select a prebuilt kernel when needed. The JSON report records separate outcomes for the fixture type check, graph conformance, and the Bend law.
