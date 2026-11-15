# DeepSeek Harness telemetry

A DSH plugin that sends every live session event to the analyzer collector as OTLP logs,
so DSH sessions show up in the dashboard, menu bar and MCP next to Claude Code.

DSH's own `dsh-session-telemetry-otel` only exports after `/feedback`, so it can't feed a
live view. This plugin listens on `session/event` and posts batches every second.

## Install

Add a row to `~/.dsh/cordis.patch.yml` and restart DSH:

```yaml
# CPA_DSH_TELEMETRY_START
- insert:
    - id: cpa-telemetry
      name: "file:///<repo>/apps/dsh-telemetry/src/index.js"
# CPA_DSH_TELEMETRY_END
```

Optional `config` keys: `endpoint` (default `http://127.0.0.1:4318`), `headers`
(`Authorization=Bearer cpa_...` for a remote collector), `intervalMs`, `disabled`.
The same settings can come from `CPA_OTLP_ENDPOINT`, `CPA_OTLP_HEADERS` and
`CPA_DSH_TELEMETRY_DISABLED`.

## What is sent

| DSH event | Analyzer event |
| --- | --- |
| first triggering `user/message` of a turn | `user_prompt` (length and source only) |
| `assistant/message` | `api_request` (model, tokens, duration, TTFT, stop reason) |
| `tool/call` + `tool/result` | `tool_result`, or `dsh.run_code` for the PTC wrapper |
| `tool/ptc-dispatch-start` + `tool/ptc-dispatch` | `tool_result` with `dsh.nested` |
| `llm/retry` | `api_error` |
| `subagent/catalog` + `subagent-settled` message | `dsh.subagent_spawned`, `subagent_completed` |
| `approval/asked` + `approval/decided` | `tool_decision` |
| `compaction/start` + `compaction/end` | `compaction` |
| `turn/end`, `job/settled`, `request/context`, `session/title` | `dsh.turn_end`, `dsh.job`, `dsh.request_context`, `dsh.session_title` |
| anything else not on the skip list | `dsh.<type>` with a capped body |

Prompt text, model output and tool output are never sent, only sizes, names and arguments
(capped at 2000 chars). DSH records no dollar cost, so `cost_usd` stays empty.

## History

`bun apps/dsh-telemetry/scripts/replay.ts --since 2026-11-01` replays recorded sessions from
`~/.dsh/sessions` through the same mapper. Add `--dry` to only count, `--endpoint` to target
another collector. Running it twice imports the same events twice.
