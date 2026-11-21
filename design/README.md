# Diogenes design system (v0.3)

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
- `reference/catalog.html` — the repository catalog: every kind × resolution, combined states, protocols, connection kinds, evidence, rejections. Uses `tokens.css` directly.

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

### Design proposals on the app canvas
The open thread's newest proposal is drawn over the whiteboard without changing it, and only
against the draft revision and commit it was checked at (otherwise a `stale` notice, nothing drawn).
Hooks: `data-change` on `.flow-box` and `.flow-tag`, `.flow-edge--added|removed`, `.flow-pending`.
- **added:** dashed marigold, `proposed-tint` fill, `ADD · rN→rM` tag. Connections dashed marigold.
- **removed:** dashed poppy, `reject-tint` fill, struck-through name. Connections poppy dash 2/4 with `✕`.
- **updated:** marigold border. **indexed** (a component the map has no box for): dotted steel.
- `.flow-pending`: legend at the bottom of the canvas; dashed marigold while pending, moss once approved.
Discarding or revising the proposal removes the drawing.

## Repository catalog (v0.3)
Everything on the canvas comes from the catalog. All v0.2 graph rules still apply; this section adds
what each catalog concept looks like. Markup hooks: `data-kind`, `data-resolution`, `data-state`,
`data-protocol` on nodes, ports and edges.

### Kinds
Each kind has a 15px icon (paths in `tokens.json → catalog.kinds.*.icon`, 24px viewBox, stroke 1.8)
and an OffBit TYPE label in the header (`.dg-node__type`, text-3, max 8 chars).

| kind | TYPE label | node | shows |
|---|---|---|---|
| module | MODULE | compact | ecosystem · package |
| workload | its role: SERVICE / WORKER / CLI / PROCESS / JOB | full | role, entry |
| operation | OP | compact | protocol · address (`POST /refunds`, `github:listRepos`) |
| resource | its type: STORE / QUEUE / TOPIC / BUCKET / ASSET | full | type, address |
| dataContract | SCHEMA | compact | format · version |
| stateMachine | STATES | full | initial state, state count |
| view | VIEW | compact | route |
| trigger | TRIGGER | compact | cron or event name |
| workflow | FLOW | full | entry step, step count |
| generic | NODE | compact | a kind hint |

- **Full nodes** use the v0.2 anatomy (header 40 → description 36 → fields 58 each → footer 36).
- **Compact nodes** are 40px with two lines: the name (Manrope 12/600) over the key attribute
  (OffBit 10, text-2), plus the TYPE label on the right. A 22px status strip appears under them only
  when they're unresolved or in error.
- The description row is now a fixed 36px, so ports always line up with their fields.

### Resolution (how sure we are)
Resolution never changes layout. It sets only border style, fill, icon tone and port fill.

- **bound** (`data-resolution="bound"`, the default): 1px solid `border-strong`, `surface-2`, filled ports.
- **declared**: 1px solid `border` (quieter), `surface-1`, icon and title in `text-2`. The footer evidence
  is prefixed `CFG` because it came from config.
- **unresolved**: 1px **dotted** `unresolved` border, `surface-1` with a faint 45° hatch, icon in `text-3`,
  and ports filled at 40% of their color. A status row (`.dg-node__status[data-tone="unresolved"]`)
  explains why, in steel with a dotted `?` glyph. It's steel on purpose, not poppy, so uncertainty
  never reads as an error.
- **proposed**: unchanged from v0.2 (dashed marigold, faint marigold fill, hollow ports).
  `data-state="proposed"` still works as an alias.

**Combining with interaction state:** resolution owns the border *style*; state owns the border *color*,
the ring and the top bar. Color priority is error > selected > running > resolution. For example:
- selected + unresolved = dotted marigold border + ring + the reason row.
- proposed + error = dashed poppy border, hollow ports, and an error row.
- running + declared = the quiet border with the moss top bar.

### Port protocols
There are ten protocols, five colors and four shapes. Within a family, the OffBit protocol code is
the second signal: it appears in the footer output (`IPC ▾`), on the edge chip on hover, and in the
port's tooltip and `aria-label`.

| protocol | code | family · color | shape |
|---|---|---|---|
| http, rpc, electron-ipc, cli | HTTP, RPC, IPC, CLI | request · `port-request` (marigold) | circle |
| data, state | DATA, STATE | data · `port-data` (steel) | square |
| event, schedule | EVT, SCHED | event · `port-event` (moss) | diamond |
| navigation | NAV | navigation · `port-nav` (label yellow) | triangle |
| local | LOCAL | local · `port-local` (text-2) | circle |

**Auth is retired.** No catalog protocol carries it: auth traffic is http/rpc to an auth resource or
operation. Its yellow now means navigation. `--dg-port-auth` and `data-type="auth"` remain as
deprecated aliases until v0.4.

### Connection kinds
Edges are still colored by their source port. A kind gets its own treatment only when it changes meaning:

- **contains:** never drawn as a line. The parent becomes a `.dg-group` frame around its children,
  with an OffBit `TYPE · name` tab. A collapsed parent shows a `▸ N` badge (`.dg-node__contains`).
- **depends_on:** grey (`text-3`) dotted 1px line. Structural, never colored by port.
- **calls:** the default edge, with no chip.
- **publishes_to / subscribes_to:** chips `PUB` / `SUB`.
- **reads / writes:** chips `R` / `W`. When both run between the same pair, they merge into one edge with chip `R/W`.
- **triggers:** chip `TRIG`.
- **flows_to:** 2px line with an arrowhead (workflow order).
- **navigates_to:** an arrowhead.

Chips (`.dg-edge-chip`) are OffBit 9, uppercase, with a 1px border in the edge color, centered on the
curve's midpoint.

Edge resolution follows node resolution:
- declared: 45% opacity.
- unresolved: dash 2/4 with a `?` chip.
- proposed: dash 5/4.
- rejected: poppy dash with an `✕ CODE` chip.

### Source evidence
- **Format:** `path:start–end` (en dash), e.g. `src/main/github.ts:42–58`.
- **Footer:** evidence sits on the left of the footer (`.dg-evidence`), and the output stays on the right.
  Long paths are middle-truncated so the filename and range survive
  (`src/renderer/…/RepoPicker.tsx:12–40`). Extra sources collapse into a `+N` pill.
- **Inspector:** the full list is `.dg-evidence-list`, headed `N SOURCES`. Each row is `CODE`/`CFG` · path · range.
- **Source type:** code sources go with *bound*; config sources (`data-source="config"`, `CFG` prefix) go with *declared*.
- **Compact nodes and edges:** evidence appears on hover and in the inspector.

### Rejected edits
A rejection has a poppy outline and `reject-tint`, `REJECTED · CODE` in OffBit, one plain sentence
and one action.
- **Inline** (`.dg-reject--inline`): attached 6px below the node, or at the edge midpoint, with a
  caret. The node or edge also turns poppy (`data-rejected="true"` / `data-state="rejected"`). Action: Undo.
- **Global** (`.dg-reject--global`): a full-width banner at the top of the canvas, used for edits that
  aren't tied to one node (`stale`, `unsupported`). Action: the fix, e.g. Re-scan.

| code | scope | message |
|---|---|---|
| stale | global | The repo changed since this canvas was scanned. Re-scan, then try again. |
| duplicate | node / edge | That already exists on the canvas. |
| missing | node / edge | The node or port this edit refers to no longer exists. |
| dangling | edge | This connection has no node on one end. |
| invalid-node | node | This node is missing a required field. |
| invalid-edge | edge | That connection kind isn't allowed between these two nodes. |
| invalid-port | node (port) | That port doesn't exist on this node. |
| incompatible | edge / port | These ports speak different protocols. |
| unsupported | global | This change can't be made from the canvas yet. |
