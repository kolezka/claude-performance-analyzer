# MCP server for coding agents

`apps/mcp` is a stdio MCP server an agent can call to see what its harness costs, so it can trim or fix hooks, plugins and memory settings. It only reads: it never changes settings or hooks.

## Install

It ships as the `performance-analyzer` Claude Code plugin. You need [Bun](https://bun.sh) on your `PATH`. Hook time also needs the telemetry the menu bar app records; without it, the injected-text answers still work and hook time says it is unavailable.

```bash
claude plugin marketplace add kolezka/marketplace
claude plugin install performance-analyzer@kolezka
```

Start a new session afterwards. The tools show up as `mcp__plugin_performance-analyzer_harness__*`.

To run it from a checkout instead, with no plugin:

```bash
claude mcp add --scope user cpa-harness -- bun "$PWD/apps/mcp/src/index.ts"
```

## Tools

| Tool | Answers |
| --- | --- |
| `harness_summary` | Start here: hook time, injected text and the Hindsight share in one answer |
| `hook_time` | Per hook: firings, total, p50, p95, max, errors, share of active turn time, and per-command runs with the plugin or settings file that owns them |
| `injected_context` | What hooks put into the model's context, grouped by source, event, prompt, session or project, with owners and identical repeats |
| `memory_cost` | Hindsight injection by tag, per prompt, recalls too large for context and whether the agent read them back |
| `harness_query` | One read-only SQL query over the same data and the telemetry tables, run in a child process and stopped after 10 seconds |

Every tool takes `session`: `current` (default), `all`, or a session id. `since` (`15m`, `1h`, `24h`, `7d`) and `project` narrow it down. `current` is the session that started the server, from `CLAUDE_CODE_SESSION_ID`; each answer names the session it used.

## Skill

The plugin ships `skills/harness-cost`, which Claude Code loads as `performance-analyzer:harness-cost`. The tools alone tell an agent what they return, not when to use them or how to act on the answer. The skill covers that: which tool answers which question, the scope arguments, how to read each number (estimates, parallel hooks, previews, unattributed text, missing telemetry) and where each owner's fix goes. `skills/harness-cost/queries.md` holds tested `harness_query` recipes. Edit the skill when a tool's output or meaning changes.

## Where the numbers come from

- Hook time comes from the collector's telemetry. All hooks of one event run in parallel, so a firing's time is wall time, not per script. Per-command times come from the transcripts, which Claude Code writes only for some hooks. The share of active turn time is given for whole sessions only, since a `since` window cuts turns in half.
- Injected text comes from the session transcripts in `~/.claude/projects`, counted as the model received it, including the reminder wrapper Claude Code puts around it. Output too large for context counts as the preview Claude Code showed; it counts as read back only when the agent read the whole saved file with the Read tool and the read succeeded. Reads through Bash (`cat`) are not counted, so read-back is a lower bound. Telemetry's own character count differs: it counts that output at full size and does not see every hook.
- Tokens are estimates: characters / 4.
- A block that no recorded hook run printed is reported as unattributed, with the hooks configured for that event. Hindsight blocks are recognised by their `<hindsight_*>` tags.
- Transcripts stay on the machine that ran the session, so the server covers sessions on this Mac, not remote hosts.

## Development

`bun apps/mcp/scripts/probe.ts harness_summary '{"session":"all","since":"7d"}'` runs one tool from the shell and prints how long it took.

To try the plugin build for one session: `bun run build:plugin`, then `claude --plugin-dir .`. Releases come from the `Release plugin` workflow, which builds `dist/` onto the `release` branch the marketplace installs from. Bump `version` in `.claude-plugin/plugin.json` first; the workflow refuses to republish the same version.
