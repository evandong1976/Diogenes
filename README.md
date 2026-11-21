# Diogenes

A visual system-design canvas for coding agents. Read a repo (or start blank), see its architecture in three levels (Infrastructure → Integrations → Code logic), plan changes on the canvas, and export the plan to Claude Code, Cursor, etc.

## Setup

Requires Node 22+ and pnpm (`corepack enable`).

```bash
pnpm install
pnpm dev
```

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
