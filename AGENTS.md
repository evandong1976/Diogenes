# Diogenes: instructions for coding agents

Electron + React + TypeScript, managed with pnpm. See `README.md` for setup and folder ownership.

## UI: use the design system

`design/` is the only source of truth for how the UI looks. It changes often, so read it before every UI task instead of relying on memory or on this file:

1. Read `design/README.md` (rules) and `design/tokens.css` (the `--dg-*` variables and `.dg-*` classes). The pages in `design/reference/` show the intended result.
2. Style everything with those variables and classes. Never hardcode a color, font, size or radius. If something you need is missing, add it to `design/tokens.css` and `design/tokens.json` in the same change.
3. Layout-only CSS goes in `src/renderer/src/assets/app.css`. No other stylesheets and no UI libraries.
4. If you change `design/`, update existing UI that uses a renamed or removed variable, class or attribute (`git grep` for it).

## Architecture

- The renderer has no Node access. Disk, network, tokens and API keys stay in `src/main` and reach the UI through typed functions in `src/preload`.
- Adding an agent tool or a Gemini-backed operation? Follow `agents/README.md`.

## Before you finish

Run `pnpm typecheck && pnpm lint`.
