# Diogenes agent reference

Start here when adding an agent tool or integrating the canvas with the backend. The TypeScript contracts and Electron handlers define the runtime interface. Update this reference in the same change when those interfaces change.

- [Tool catalog](tool-catalog.md) lists callable tools, inputs, outputs, and the next proposed additions.
- [Approval → coding → verification workflow](workflow.md) defines the shared interfaces for approvals, runs, candidates and verdicts.
- [Workflow and handoffs](handoffs.md) shows what each teammate can build against and how to check the full demo.
- [Integrated backend and persistence](persistence.md) covers the project-scoped bridge, authorization, Postgres storage and the smoke check.
- [Gemini contracts](../src/shared/gemini.ts) define the types and IPC channels shared by main, preload, and renderer.
- [Background-job examples](../fixtures/background-job/example.json) provide sample graph, edit, and clarification responses for development without live API calls.

## Adding a tool

1. Define the smallest typed input and output in `src/shared/`. Reuse an existing type when it fits.
2. Implement filesystem, network, or process work in `src/main/`. Validate incoming IPC arguments and model output there.
3. Expose one named operation through `src/preload/`. The renderer uses the typed bridge.
4. Update the catalog with the caller, where it runs, what it can change, and a fixture or test that exercises the contract.

Set `GEMINI_API_KEY` in the environment used to launch Electron. The main process reads it. Keep keys out of fixtures, logs, exported handoffs, and the renderer.
