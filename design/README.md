# Diogenes design system (v0.2)

A dense, technical dark UI in the spirit of Factory / Conductor: hairlines instead of shadows,
2px corners, tight spacing, and a palette pulled from the "carpet pile" reference photo
(forest black, olive, cream, marigold, label yellow, poppy, moss, steel).

## Files
- `tokens.json` — source of truth for color, type, spacing, radius, sizes.
- `tokens.css` — the same tokens as CSS variables (`--dg-*`) plus base classes
  (`.dg-btn`, `.dg-input`, `.dg-pill`, `.dg-kbd`, `.dg-label`, `.dg-canvas`, `.dg-node`).
  Imported once in `src/renderer/src/main.tsx`. Fonts are bundled there (`@fontsource/manrope`,
  `@fontsource/pixelify-sans`); don't add remote font imports, the app's CSP blocks them.
- `reference/canvas.html` — the main canvas screen (open in a browser).
- `reference/system-sheet.html` — tokens and components on one sheet.
- `reference/graph-elements.html` — node states, field types, port colors, edges.

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
- **Levels:** L1 Infra, L2 Integrations, L3 Logic — switched from the toolbar/segmented control,
  always shown in the status area.
- **Prompting:** prompts are pinned to nodes (`PROMPT #n · @node_id`), and the dock's `>` input
  references nodes with `@`. Sending is always `⌘↵`.
- **Accessibility:** text-3 is the floor for small text (≥4.5:1 on bg). Focus = 1px marigold outline.

## Graph (the sandbox)
The sandbox is where architecture is read and edited. It follows the node-graph pattern
(header → description → fields → output footer), kept tight and in the Diogenes palette.

- **Canvas:** `bg` with 1px `dot` dots every 16px. No other texture.
- **Node:** `surface-2`, 1px `border-strong`, 4px radius, no shadow. Default width 260px.
  - **Header (40px):** 15px icon, name in Manrope 13/600, a metric in OffBit 10 (`ok` color), and a run button.
  - **Description (≤36px):** two lines max, Manrope 11/500, `text-2`.
  - **Fields (58px each):** label (Manrope 11/600) + info icon + red `*` when required, then a 28px input with 2px corners.
    Kinds: text, secret (masked, OffBit, eye toggle), select (up/down chevrons), toggle, locked
    ("Receiving input" + lock, fed by a port) and expand (JSON/long text).
  - **Footer (36px):** `surface-1`, output type with a dropdown chevron, one output port.
- **Compact node (40px):** header only, for simple sources and sinks (web app, buckets, crons).
- **Ports:** 10px circles sitting on the node edge, 2px `bg` ring, aligned to the field they feed.
  Colors by connection type: `http` = marigold, `data` = steel, `auth` = label yellow, `event` = moss.
  Proposed nodes have hollow ports.
- **Edges:** cubic curves with horizontal tangents, 1.5px, colored by the source port.
  Dashed (5/4) when proposed; 2.5px when hovered or traced.
- **States:** selected = marigold border + 3px soft ring · running = 2px moss bar on top + live metric ·
  error = poppy border + a footer row with the reason · proposed = dashed marigold border, faint marigold fill.
- **Prompt pin:** a node-like card with a marigold border, `PROMPT #n · @NODE` header, the prompt text and a
  primary "Send to Claude Code ⌘↵" button. It wires to the node it's about with an `http` port.
