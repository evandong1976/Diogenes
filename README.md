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
