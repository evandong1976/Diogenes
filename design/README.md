# Diogenes design system (v0.1)

A dense, technical dark UI in the spirit of Factory / Conductor: hairlines instead of shadows,
2px corners, tight spacing, and a palette pulled from the "carpet pile" reference photo
(forest black, olive, cream, marigold, label yellow, poppy, moss, steel).

## Files
- `tokens.json` — source of truth for color, type, spacing, radius, sizes.
- `tokens.css` — the same tokens as CSS variables (`--dg-*`) plus base classes
  (`.dg-btn`, `.dg-input`, `.dg-pill`, `.dg-kbd`, `.dg-label`, `.dg-canvas`, `.dg-node`).
  Imported once in `src/renderer/src/main.tsx`, along with the bundled fonts (`@fontsource-variable/manrope`, `@fontsource/pixelify-sans`).
- `reference/canvas.html` — the main canvas screen (open in a browser).
- `reference/system-sheet.html` — tokens and components on one sheet.

## Fonts
- **Manrope** — names, body text, buttons, inputs.
- **OffBit** — labels, IDs, file paths, numbers, shortcuts, logs. Uppercase labels get +0.06em tracking.
  OffBit isn't bundled yet: add the font files under `design/fonts/` and uncomment the `@font-face`
  in `tokens.css`. Until then Pixelify Sans stands in.

## Rules
- **Corners:** 0 on panes, 2px on controls and nodes. Nothing rounder.
- **Spacing:** 4px grid. Controls 26px tall, list rows 24px, table rows 28px, panel padding 8–10px.
- **Depth:** no shadows. Separate with 1px `border` hairlines; use `surface-1/2/3` steps for elevation.
- **Accent:** marigold means "action or change" — primary button, selection, proposed nodes,
  pending prompts. Don't use it for decoration.
- **Status:** moss = healthy/ok, label yellow = draft/warning, poppy = error/destructive, steel = info.
- **Canvas:** 24px line grid. Nodes are spec cards: a header row (`TYPE` · `id` in OffBit), name
  in Manrope 13/600, one line of OffBit metadata, 6px square ports on the sides. Edges are 1px
  `connector` lines with an OffBit label chip (SQL, JWT, CDC). Proposed nodes and edges are dashed
  marigold. Selected nodes get a marigold border and four square corner handles.
- **Levels:** L1 Infra, L2 Integrations, L3 Logic — switched from the toolbar/segmented control,
  always shown in the status area.
- **Prompting:** prompts are pinned to nodes (`PROMPT #n · @node_id`), and the dock's `>` input
  references nodes with `@`. Sending is always `⌘↵`.
- **Accessibility:** text-3 is the floor for small text (≥4.5:1 on bg). Focus = 1px marigold outline.
