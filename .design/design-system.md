# Design system: console-paper

Chosen direction: `dashboard/console-paper` (current version v2). Hard constraint for further drafts and the implementation.

## Layout
- App shell: left sidebar `w-56` (logo `cc/speed`, host select, nav, Setup section, Live footer), header with page title and 15m/1h/24h/7d segmented control, main grid `xl:grid-cols-[1fr_340px]` with the Live rail on the right.
- Overview content order: KPI grid (6 tiles, sparklines), API latency chart, Slowest turns table, Hooks and Tools & MCP bars.

## Type
- Headings (h1, h2): serif `"Iowan Old Style", Charter, Georgia, serif`, weight 600, tracking -0.01em, h1 18px.
- Body: system sans, 13px. Numbers, timestamps, identifiers: JetBrains Mono.

## Colour (warm stone neutrals)
- Light: 50 #f7f4ee, 100 #efeae1, 200 #e2dbcf, 300 #cfc6b6, 400 #968b78, 500 #6b6253, 600 #5e5649, 700 #463f35, 900 #26211b, surface white #fffdf8.
- Dark: page #1c1813, sidebar #14110d, raised surface #2a241c, hairline #3a3226.
- Signals: api #3b6fd4, tools #d26a2c, hooks #2a9a6b, warn #b07d14, crit #d24b46. One meaning per colour, every colour has a dark pair.

## Shape
- Radius: sm 4px, md 8px, lg 12px. Hairline borders, no heavy shadows.

## States
- Running items: pulsing dot or `animate-pulse` bar; empty host: dashed card with setup instruction; missing data: grey `n/a` plus what enables it.

## Pages
Accepted page drafts, all `variant: paper`, same shell as `dashboard/console-paper/v2`:
- Overview: `dashboard/console-paper/v2`
- Turns, Hooks, Tools & MCP, Models, Errors, Remote hosts, Telemetry settings: `<page>/paper/v1` (targets `turns`, `hooks`, `tools`, `models`, `errors`, `hosts`, `settings`).
- Data the collector does not serve yet is listed per draft in `meta.json` `proposed`.
