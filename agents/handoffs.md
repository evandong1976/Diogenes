# Workflow and handoffs

The demo fixture starts with a background job that fails immediately. The desired change is to retry once, then mark it failed if the retry also fails.

| Owner                                 | Handoff                                                                                                                                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo import and graph                 | Pass the canvas a `CurrentGraph`. Resolve source references against the files supplied to Gemini. The bundled fixture is the current integration point.                                                                                 |
| Visual input and Gemini               | Pass the current graph and annotated PNG bytes to Carbon. Hand the canvas the resulting `ProposalResult`, including the clarification branch.                                                                                           |
| Canvas and approval                   | Display the original graph and the proposed change. On approval, hand off the original and accepted behavior, related source references, and any user clarification. The saved JSON examples let this work proceed without credentials. |
| Coding-agent handoff and verification | Export a brief with explicit behavior and acceptance checks. Check that an initial failure gets exactly one retry, a successful retry succeeds, and a failed retry ends the job without a third attempt.                                |

## Replay the Gemini fixture

`node scripts/prove-gemini.ts --check-example` validates the saved responses and exercises invalid-response cases without API calls. `node scripts/prove-gemini.ts` runs the live model calls with `GEMINI_API_KEY` set. See the [project README](../README.md#gemini-background-job-fixture) for setup.

The Gemini proof checks graph and edit payloads. Verification of the coding agent’s implementation needs its own executable acceptance check.
