# Diogenes: instructions for coding agents

Electron + React + TypeScript, managed with pnpm. See `README.md` for setup and folder ownership.

## UI: use the design system

All renderer UI follows `design/README.md`. Read it before touching anything in `src/renderer`.

- Use the `--dg-*` CSS variables from `design/tokens.css` for every color, font, spacing step, radius and size. Never hardcode hex values or font names.
- Use the existing classes before writing new CSS: `.dg-btn` (plus `--primary`, `--ghost`, `--danger`), `.dg-input`, `.dg-pill`, `.dg-kbd`, `.dg-label`, `.dg-data`, `.dg-canvas`, `.dg-node`.
- Layout-only CSS goes in `src/renderer/src/assets/app.css`. No other stylesheets and no UI libraries.
- Rules that are easy to break: 2px corners at most, no shadows (separate with 1px hairlines), marigold `--dg-accent` only for actions, selection and proposed changes, 4px spacing grid.
- New tokens go in `design/tokens.json` and `design/tokens.css` together.

## Architecture

- The renderer has no Node access. Disk, network, tokens and API keys stay in `src/main` and reach the UI through typed functions in `src/preload`.
- Adding an agent tool or a Gemini-backed operation? Follow `agents/README.md`.

## Before you finish

Run `pnpm typecheck && pnpm lint`.
