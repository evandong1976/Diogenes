# Diogenes

A visual system-design canvas for coding agents. Read a repo (or start blank), see its architecture in three levels (Infrastructure → Integrations → Code logic), plan changes on the canvas, and export the plan to Claude Code, Cursor, etc.

## Setup

Requires Node 22+ and pnpm (`corepack enable`).

```bash
pnpm install
cp .env.example .env   # then fill in the client ID (below)
pnpm dev
```

### GitHub sign-in

Sign-in uses GitHub's [device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow), so there's no client secret and no redirect server. The token stays in the main process, encrypted with Electron `safeStorage`.

The team shares one GitHub OAuth App. To create one: GitHub → Settings → Developer settings → OAuth Apps → New. Any homepage and callback URL will do. Tick **Enable Device Flow**, then put its Client ID in `.env` as `MAIN_VITE_GITHUB_CLIENT_ID`.

## Layout

[Agent tools and teammate handoffs](agents/README.md)

| Folder         | What lives here                                                     |
| -------------- | ------------------------------------------------------------------- |
| `src/main`     | Electron main process: filesystem, git/GitHub, repo parsing, export |
| `src/preload`  | The typed bridge exposing main-process APIs to the UI               |
| `src/renderer` | React UI: the canvas and level navigation                           |

The renderer has no Node access. Anything touching disk or network goes in `main` and is exposed through `preload`.

## Scripts

- `pnpm dev`: run the app with hot reload
- `pnpm typecheck` / `pnpm lint` / `pnpm format`
- `pnpm build:mac` (or `:win`, `:linux`): package the app

## Gemini background-job fixture

Launch Electron with `GEMINI_API_KEY` set in its environment. The main process reads the key and calls Gemini. The renderer uses the typed preload API.

```ts
const graph = await window.api.gemini.buildCurrentGraph()
const png = new Uint8Array(await pngFile.arrayBuffer()) // pngFile is a File
const result = await window.api.gemini.proposeEdit(graph, png)
```

- `buildCurrentGraph()` sends the two fixture source files to `gemini-4-hydrogen` and returns a validated `CurrentGraph`. Source paths are relative to [the fixture source folder](fixtures/background-job/source), and line ranges are 1-based and inclusive.
- `proposeEdit(graph, png)` sends the graph and PNG bytes to `gemini-4-carbon`. For `kind: 'edit'`, render a preview by removing `replaceTransitionId` and appending `addStates` and `addTransitions` to a copy of the graph. For `kind: 'clarification'`, show `question` and wait for a revised annotation.
- Both promises reject on invalid input, invalid model output, or a provider or transport error. Shared types live in [src/shared/gemini.ts](src/shared/gemini.ts).

Run the live proof with `node scripts/prove-gemini.ts` on Node 22.18+ with the key in the shell environment. It sends [the retry annotation](fixtures/background-job/retry-once.png) and [an ambiguous annotation](fixtures/background-job/ambiguous.png) for the same fixture. It checks that the retry has success and terminal failure outcomes, and that the ambiguous annotation yields a question.

The [validated example JSON](fixtures/background-job/example.json) captures all three live responses. Run `node scripts/prove-gemini.ts --check-example` to validate those examples and exercise invalid-response checks without API calls.
