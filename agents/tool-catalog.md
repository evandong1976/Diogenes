# Tool catalog

## Available in the Gemini backend

| Tool                                        | Input                         | Return           | Effect                                                                          |
| ------------------------------------------- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `window.api.gemini.buildCurrentGraph()`     | Bundled background-job source | `CurrentGraph`   | Hydrogen reads the fixture and returns its graph.                               |
| `window.api.gemini.proposeEdit(graph, png)` | Graph and PNG bytes           | `ProposalResult` | Carbon interprets the markup and returns a preview or a clarification question. |

Both run through the [typed preload bridge](../src/preload/index.ts) and use [main-process Gemini handlers](../src/main/gemini/ipc.ts). They make API requests and return data. The canvas owns accepting an edit. The graph builder currently reads two bundled files, so its output references `job.ts` and `worker.ts` relative to the [fixture source folder](../fixtures/background-job/source).

For `kind: 'edit'`, preview the replacement on a copy of the graph. Remove the transition identified by `replaceTransitionId` and append `addStates` and `addTransitions`. For `kind: 'clarification'`, display `question` and let the user revise the markup. Both calls can reject on invalid input, invalid output, or an API failure.

## Proposed tools

These are ownership targets for teammates. Add a callable name here when its interface exists.

| Tool                | Purpose                                                                | Expected behavior                                               |
| ------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| Inspect component   | Show a selected component, its neighbors, and its code references.     | Reads the current graph.                                        |
| Apply approved edit | Update the canvas with a reviewed change.                              | Changes the working diagram after the user accepts the preview. |
| Export agent brief  | Package the approved change, source references, and acceptance checks. | Produces a Markdown handoff for a coding agent.                 |
| Verify behavior     | Run a specific acceptance check against the implementation.            | Reports the check, observed result, and pass or fail.           |
