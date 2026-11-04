# Development

## Build from source

You need [Bun](https://bun.sh) and Xcode 26.

```bash
git clone https://github.com/kolezka/claude-performance-analyzer.git
cd claude-performance-analyzer
bun install
bun run start      # collector and dashboard on http://127.0.0.1:4318
bun run app        # build and open the menu bar app
```

Then connect Claude Code as described in the [README](../README.md#get-started).

## Everyday commands

```bash
bun run dev        # collector in development mode
bun test           # all packages
bun run typecheck
```

A `Makefile` wraps the same commands. Run `make` to list targets.

## How it works

```
                       this Mac
Claude Code ──OTLP, loopback──────────▶ collector :4318 ──▶ SQLite
                                         │  (127.0.0.1 only, or
remote machine (optional)                │   all addresses once a
Claude Code ──OTLP, Tailscale/LAN+token─▶│   remote host exists)
                                         │
                                         ├── /api/* over loopback ──▶ menu bar app
                                         └── web dashboard over loopback
```

Claude Code exports logs, metrics and traces over OTLP. The collector decodes them, stores them in `~/.claude-telemetry/telemetry.sqlite` and serves a small JSON API. The menu bar app and the dashboard both read from that API over loopback.

Without remote hosts, nothing leaves your machine. With them, each remote machine's telemetry crosses your tailnet or your LAN to this Mac, authenticated by its token. Stored data and every API read stay on this Mac. Every stored row carries the host its token belongs to, and each read shows one host at a time.

## Project layout

Bun workspaces. Each package has its own `src/` and `test/`.

| Path | What it does |
| --- | --- |
| `apps/collector` | Bun OTLP receiver (http/json or http/protobuf, gzip ok) on `127.0.0.1:4318`, or on all addresses while remote hosts exist. Stores to SQLite with 14 day retention, partitioned by host. Serves the dashboard and the JSON API. `scripts/compile.ts` builds it into a standalone binary for the app bundle. |
| `apps/dashboard` | Svelte web dashboard, bundled by the collector through its HTML import. |
| `apps/mcp` | Read-only stdio MCP server for coding agents: hook time, hook-injected context and Hindsight memory cost, from telemetry and session transcripts. See [mcp.md](mcp.md). |
| `apps/menubar` | SwiftUI menu bar app (`MenuBarExtra`), built with `swiftc` into a universal (arm64 and x86_64) `.app`. Bundles the compiled collector and runs it as a LaunchAgent. Code in `Sources/`, plists and icon in `Resources/`, build and release in `scripts/`. |
| `packages/otlp` | Decodes OTLP http/json and http/protobuf into rows. |
| `packages/analytics` | Summaries, percentiles, turn timelines. Shared by the collector and the dashboard. |
| `packages/claude-settings` | Adds the telemetry variables to Claude Code's `settings.json`. |

## Releases

- **Menu bar app:** run the `Release menu bar app` workflow on `main` and pick `patch`, `minor` or `major`. It builds a signed, notarized `.dmg`, tags the version and publishes a GitHub release. The `release` environment holds the signing certificate and the notarization credentials, and a required reviewer approves each run. A second job then sets the new version and the DMG's sha256 in the `claude-telemetry` cask in [kolezka/homebrew-tap](https://github.com/kolezka/homebrew-tap). It pushes with the `HOMEBREW_TAP_DEPLOY_KEY` secret, a write deploy key on the tap. If only that job fails, rerun it from the run page: it does not cut a new version.
- **MCP plugin:** see [mcp.md](mcp.md#development).
