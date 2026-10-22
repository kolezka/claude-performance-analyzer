<h1 align="center">Claude Performance Analyzer</h1>

<p align="center">
  <strong>See where your Claude Code turns spend their time.</strong><br>
  Model latency, tools, hooks, skills, subagents and MCP startup, live in your macOS menu bar.
</p>

<p align="center">
  <img alt="macOS 14+" src="https://img.shields.io/badge/macOS-14%2B-black?logo=apple">
  <img alt="Built with Bun" src="https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=black">
  <img alt="SwiftUI" src="https://img.shields.io/badge/UI-SwiftUI-F05138?logo=swift&logoColor=white">
  <img alt="Local only" src="https://img.shields.io/badge/data-local%20only-2ea44f">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center">
  <img src="docs/screenshots/menubar-demo.gif" alt="Demo: opening the menu bar panel, switching time windows and filters, and opening a hook's detail card" width="360">
  <br>
  <sub><a href="docs/screenshots/menubar-demo.mp4">Watch the demo in full quality (MP4)</a></sub>
</p>

---

## Why

A slow Claude Code turn can come from many places: the model, a long Bash call, a hook that runs on every prompt, an MCP server that takes seconds to connect. Claude Code already reports all of this through OpenTelemetry. Claude Performance Analyzer collects that data on your machine and turns it into answers:

- Is the model slow right now, or is it my setup?
- Which hook adds time to every prompt?
- Which tools, skills and subagents eat the most time?
- What did this session cost, and how well is the prompt cache working?

## Features

- **Glanceable menu bar label.** API p50 latency over the last 15 minutes. It turns into a warning triangle when hooks are slow.
- **Native SwiftUI panel.** Headline numbers, a latency chart, the API, tools and hooks split, and ranked lists, in 15m, 1h, 24h or 7d windows.
- **Drill-down detail cards.** Click any row to see its count, failures, p50, p95 and max, a split by repository, and recent calls.
- **Live feed.** Hook, tool and model events as they arrive, within a few seconds.
- **Web dashboard.** Turn waterfall, recent prompts, skills, subagents, models, permission decisions, MCP connect times, errors and compaction.
- **One-click setup.** The dashboard adds the needed telemetry variables to `~/.claude/settings.json`, keeps your existing values and writes a backup first.
- **Remote hosts.** Other Linux or macOS machines on your tailnet can send their telemetry here, each with its own token. Pick a host in the panel or the dashboard to see its numbers.
- **Private by design.** With no remote hosts the collector listens on `127.0.0.1` only. Data stays in a local SQLite file for 14 days.

## Quick start

**Requirements:** macOS 14 or later.

Download the `.dmg` from the [latest release](https://github.com/kolezka/claude-performance-analyzer/releases/latest), drag ClaudeTelemetry to Applications and open it. The app ships the collector and starts it in the background as a login item, so it keeps recording while the app is closed. You can turn it off in Settings > General, or in System Settings > General > Login Items.

To build from source instead, you need [Bun](https://bun.sh) and Xcode 26:

```bash
git clone https://github.com/kolezka/claude-performance-analyzer.git
cd claude-performance-analyzer
bun install
bun run start      # collector and dashboard on http://127.0.0.1:4318
bun run app        # build and open the menu bar app
```

Then connect Claude Code. Open http://127.0.0.1:4318 and use the setup button, or add these to the `env` block of `~/.claude/settings.json` yourself:

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

Start a new Claude Code session. Only sessions started after this point are recorded.

The setup button always configures this Mac, whichever host you have selected.

## Remote hosts

Claude Code on another machine (Linux or macOS) can send its telemetry to the collector on this Mac over [Tailscale](https://tailscale.com). Nothing of ours runs on the other machine.

1. On this Mac, open the Hosts section in the dashboard or the Hosts tab in the app's Settings, and add a host with a name.
2. Copy the `env` block it shows. It holds the host's token and this Mac's Tailscale address, and it is shown only once. Regenerate the token if you lose it.
3. Paste the block into the `env` of `~/.claude/settings.json` on the other machine and start a new Claude Code session there.

The block looks like this:

```json
{
  "env": {
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://100.x.y.z:4318",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer cpa_...",
    "...": "the same telemetry variables as above"
  }
}
```

If this Mac has no Tailscale address when you add the host, the block says `<THIS_MAC_TAILSCALE_IP>`. Replace it with the address from `tailscale ip -4`.

What to expect:

- Adding the first host makes the collector listen on all addresses (`::`, IPv4 and IPv6). macOS may ask once whether to allow incoming connections. Removing the last host takes it back to `127.0.0.1` only. Neither needs a restart.
- Remote data is accepted only from Tailscale addresses (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) and only with a valid token. Anything else gets `401` or `403` and nothing is stored.
- The dashboard, the API, setup, host management and the live feed answer to this Mac only. A tailnet peer gets `403` on all of them, even with a faked `Host` header.
- Removing a host deletes its token and all of its saved telemetry. Regenerating a token stops the old one at once.
- This Mac cannot see the other machine's disk, so remote rows show the paths as they were sent, with no repo name, worktree or branch lookup. Remote hooks show what telemetry registered (event, matcher, source, plugin), not the command or config file.

## The menu bar app

<img src="docs/screenshots/menubar-panel.png" alt="Menu bar panel with API latency, turn time split, slowest and total-time rankings, and live feed" width="320" align="right">

<img src="docs/screenshots/menubar-label.png" alt="Menu bar label showing API p50 latency" width="64">

The **label** shows API p50 latency over the last 15 minutes and refreshes every 2 seconds. Hooks count as slow when they take more than 15% of in-turn time, or when one hook has a p95 above 2s. Then the gauge changes to a warning triangle.

Click the label to open the **panel**:

| Section | What it shows |
| --- | --- |
| Header | Host picker (This Mac or a remote host), time window picker (15m, 1h, 24h, 7d) and collector status |
| Headline numbers | API p50 and p95, time to first token, turn duration, cost, cache hit rate, sessions |
| API latency | p50 and p95 over time |
| Where turn time goes | Split between API, tools and hooks |
| Slowest | Top items by p95, filtered by tools, hooks or agents |
| By total time | Top items by summed duration, with the same filters |
| Live | Latest hook, tool and model events |

The panel polls only while it is open.

**Settings** let you launch at login, pick the default window and the windows in the header, point at another collector URL, tune polling intervals, change the label style, set the panel width and hide any section. The **Hosts** tab adds, regenerates and removes remote hosts.

<br clear="right">

## How it works

```
                       this Mac
Claude Code ──OTLP, loopback──────────▶ collector :4318 ──▶ SQLite
                                         │  (127.0.0.1 only, or
remote machine (optional)                │   all addresses once a
Claude Code ──OTLP, Tailscale + token───▶│   remote host exists)
                                         │
                                         ├── /api/* over loopback ──▶ menu bar app
                                         └── web dashboard over loopback
```

Claude Code exports logs, metrics and traces over OTLP. The collector decodes them, stores them in `~/.claude-telemetry/telemetry.sqlite` and serves a small JSON API. The menu bar app and the dashboard both read from that API over loopback.

Without remote hosts, nothing leaves your machine. With them, each remote machine's telemetry crosses your tailnet to this Mac, authenticated by its token. Stored data and every API read stay on this Mac. Every stored row carries the host its token belongs to, and each read shows one host at a time.

## Project layout

Bun workspaces. Each package has its own `src/` and `test/`.

| Path | What it does |
| --- | --- |
| `apps/collector` | Bun OTLP receiver (http/json or http/protobuf, gzip ok) on `127.0.0.1:4318`, or on all addresses while remote hosts exist. Stores to SQLite with 14 day retention, partitioned by host. Serves the dashboard and the JSON API. `scripts/compile.ts` builds it into a standalone binary for the app bundle. |
| `apps/dashboard` | Svelte web dashboard, bundled by the collector through its HTML import. |
| `apps/menubar` | SwiftUI menu bar app (`MenuBarExtra`), built with `swiftc` into a universal (arm64 and x86_64) `.app`. Bundles the compiled collector and runs it as a LaunchAgent. Code in `Sources/`, plists and icon in `Resources/`, build and release in `scripts/`. |
| `packages/otlp` | Decodes OTLP http/json and http/protobuf into rows. |
| `packages/analytics` | Summaries, percentiles, turn timelines. Shared by the collector and the dashboard. |
| `packages/claude-settings` | Adds the telemetry variables to Claude Code's `settings.json`. |

## Development

```bash
bun run dev        # collector in development mode
bun test           # all packages
bun run typecheck
```

A `Makefile` wraps the same commands. Run `make` to list targets.

## Limits

- Only sessions started after telemetry is turned on are recorded. There is no backfill.
- Rules have no timing in telemetry. They only appear as `source: config` permission decisions.
- Hook timing is per hook event and matcher (`PreToolUse:Bash`), not per script. Per-script detail needs detailed beta tracing.
- "Where turn time goes" adds up component durations, so parallel tool calls overlap.

## License

[MIT](LICENSE) © 2026 Mariusz Rakus

`packages/otlp/proto/` holds the OTLP `.proto` definitions from [open-telemetry/opentelemetry-proto](https://github.com/open-telemetry/opentelemetry-proto) v1.11.1, Apache 2.0 (see `packages/otlp/proto/LICENSE`).
