# Claude Performance Analyzer

A macOS menu bar widget that shows where your Claude Code turns spend their time: model latency, tools, hooks, skills, subagents and MCP startup. The data comes from Claude Code's own OpenTelemetry export. It is received and stored on your machine.

<p align="center">
  <img src="docs/screenshots/menubar-panel.png" alt="Menu bar panel with API latency, turn time split, slowest hooks, tools and live feed" width="360">
</p>

## Menu bar widget

<img src="docs/screenshots/menubar-label.png" alt="Menu bar label showing API p50 latency" width="64" align="left">

The label shows API p50 latency over the last 15 minutes. When hooks are slow, the gauge changes to a warning triangle. Hooks count as slow when they take more than 15% of in-turn time, or when one hook has a p95 above 2s.
<br clear="left">

Click the label to open a native SwiftUI panel:

- **Window picker:** 15m, 1h, 24h or 7d.
- **Headline numbers:** API p50 and p95, time to first token, turn duration, cost, cache hit rate and session count.
- **API latency:** p50 and p95 over time (Swift Charts).
- **Where turn time goes:** the split between API, tools and hooks.
- **Slowest hooks** by p95. A hook over 2s is flagged.
- **Tools by total time.**
- **Live:** the latest hook, tool and model events as they arrive.
- **Open Dashboard** opens the full web dashboard in your browser.

The label refreshes every 2 seconds. The panel polls only while it is open.

## How it works

```
Claude Code ──OTLP──▶ collector (127.0.0.1:4318) ──▶ SQLite
                               │
                               ├── /api/status, /api/summary, /api/live ──▶ menu bar widget
                               └── web dashboard
```

The collector listens on localhost only and keeps 14 days of data.

## Requirements

- macOS 14 or later
- [Bun](https://bun.sh)
- Xcode Command Line Tools (`xcode-select --install`) to build the widget with `swiftc`

## Quick start

```bash
bun install
bun run start      # collector + dashboard on http://127.0.0.1:4318
bun run app        # build and open the menu bar widget
```

Then point Claude Code at the collector. The dashboard has a button that adds any missing variables to the `env` block of `~/.claude/settings.json`. Existing values are kept, and a backup is written next to the file. Or set them yourself:

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json      # http/protobuf works too; grpc does not
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_LOGS_EXPORT_INTERVAL=1000            # how "real time" the live feed is
OTEL_LOG_TOOL_DETAILS=1                 # real skill, MCP and subagent names
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1   # optional: time to first token, turn spans
OTEL_TRACES_EXPORTER=otlp
```

Only sessions started after this point are recorded.

## Project layout

Bun workspaces. Each package has its own `src/` and `test/`.

| Path | What it does |
| --- | --- |
| `apps/collector` | Bun OTLP receiver (http/json or http/protobuf, gzip ok) on `127.0.0.1:4318`. Stores to `~/.claude-telemetry/telemetry.sqlite` with 14 day retention. Serves the dashboard and the JSON API. |
| `apps/dashboard` | Svelte web dashboard, bundled by the collector through its HTML import. |
| `apps/menubar` | SwiftUI menu bar widget (`MenuBarExtra`), built with `swiftc` into a universal (arm64 + x86_64) `.app`. |
| `packages/otlp` | Decodes OTLP http/json and http/protobuf into rows. |
| `packages/analytics` | Summaries, percentiles, turn timelines. Shared by the collector and the dashboard. |
| `packages/claude-settings` | Adds the telemetry variables to Claude Code's `settings.json`. |

## Development

```bash
bun run dev        # collector in development mode
bun test           # all packages
bun run typecheck
```

## Limits

- Only sessions started after telemetry is turned on are recorded. There is no backfill.
- Rules have no timing in telemetry. They only appear as `source: config` permission decisions.
- Hook timing is per hook event and matcher (`PreToolUse:Bash`), not per script. Per-script detail needs detailed beta tracing.
- "Where turn time goes" adds up component durations, so parallel tool calls overlap.

## Third-party files

`packages/otlp/proto/` holds the OTLP `.proto` definitions from [open-telemetry/opentelemetry-proto](https://github.com/open-telemetry/opentelemetry-proto) v1.11.1, Apache 2.0 (see `packages/otlp/proto/LICENSE`).
