# Diogenes

A visual system-design canvas for coding agents. Read a repo (or start blank), see its architecture in three levels (Infrastructure → Integrations → Code logic), plan changes on the canvas, and export the plan to Claude Code, Cursor, etc.

## Why

Coding agents are capable. What holds them back is the input we give them. Text prompts are noisy and lossy. One loosely worded line ("I think it might be due to X...") nudges the agent slightly off course. Over a lot of code that small angle turns into the wrong system, and you spend prompt after prompt steering it back. The problem multiplies when you run several agents at once, and coding through text all day burns people out.

Diogenes moves intent off text and onto a picture of your system. You show the change you want instead of describing it, so the agent gets a precise spec rather than a paragraph to interpret. You stop reading code to find out whether the agent understood you. You look at the logic you care about (services, flows, state machines) and skip implementation detail you're happy to delegate.

It's for teams who care about getting the architecture right, especially where mistakes are expensive: payment, retry and refund logic, or research code that people don't yet trust an agent to write unsupervised.

## How it works

1. **Connect a repo.** Diogenes indexes it and maps the code into a diagram, or you start from a blank canvas.
2. **Explore by zooming.** Each level shows more detail: Infrastructure → Integrations → Code logic.
3. **Plan the change.** Drag, connect and comment on components, or ask the side-panel agent ("add a queue between these two services").
4. **Send to your coding agent.** The diagram diff, chat context and the files behind each touched component become a Markdown spec plus a set of checks.
5. **Verify.** When the coding agent says it's done, Diogenes checks the code against the diagram and sends back what's still wrong until the checks pass.

## Design principles

- **A fixed component catalog.** Diagrams are built from predefined types (service, database, queue, API route, external API, UI screen, state machine...), each with typed connections. Anything outside the catalog becomes a plain box marked as untyped. Diagrams stay predictable, and the agent works with known building blocks instead of inventing new ones.
- **The agent edits the diagram, not the repo.** The in-app agent uses a small tool set: list, inspect, create, delete, edit and connect components. Code changes go to your existing coding agent.
- **Deterministic verification.** Checks are mechanical, such as "this new component maps to real files" or "this new connection is a real call or import". A cheap model only turns failures into feedback for the coding agent.
- **The human designs.** Diogenes doesn't propose architecture on its own. It makes your choices exact and checks they were carried out.

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
