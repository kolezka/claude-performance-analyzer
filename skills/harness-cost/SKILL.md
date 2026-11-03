---
name: harness-cost
description: Use when Claude Code feels slow before it answers, sessions start slowly, context is already large before any work, or the user asks which hooks, plugins or Hindsight memory cost time or tokens, wants to trim them, or wants to know whether a hook or plugin change helped.
---

# Measuring what the harness costs

The performance-analyzer plugin's `harness` MCP server reads session transcripts and the collector's telemetry. It reports three costs: hook wall time, text that hooks inject into the model's context, and Hindsight memory's share of that text. Each cost names the plugin or settings file that owns it. The server only reads. You propose changes, the user approves them.

The tools are `mcp__plugin_performance-analyzer_harness__<tool>`. If they are deferred, load them with ToolSearch (`select:` plus the full names) before calling.

## Pick the tool

| Question | Call |
| --- | --- |
| Any harness cost question, first call | `harness_summary` |
| Which hook is slow, and who owns it | `hook_time` |
| What fills context before work, or on every prompt | `injected_context`, `group_by`: `source` (default), `event`, `prompt`, `session`, `project` |
| Is Hindsight worth it | `memory_cost`; per project needs `harness_query` |
| Anything else | `harness_query`, tested recipes in `queries.md` next to this file |

Every tool takes the same scope:

- `session`: `current` (default) is the session that started the server. `all` covers every session. A session id or an 8+ character prefix picks one past session.
- `since`: `15m`, `1h`, `24h`, `7d`. With `session: "all"` it defaults to `24h`, so pass `7d` when the user means the last week.
- `project`: text in the working directory, with `session: "all"`.

The first line of every answer states the scope it used. Quote it with the numbers.

## Read the numbers

- **Tokens are estimates**, characters / 4. Say "about".
- **Hook text is not the whole context.** `/context` also counts the system prompt, CLAUDE.md files, tool and skill listings and the conversation. These tools see none of that, so never present hook text as the full context size.
- **Hook time is per event firing.** All hooks of one event run in parallel, so a firing takes about as long as its slowest hook, not the sum.
- **Per-command times exist only for some events.** `hook_time` lists which ones (usually SessionStart and PreToolUse). For the rest, such as UserPromptSubmit, Stop or PostToolUse, you get the event time and how many hooks ran, not which hook was slow. Name the hooks configured for that event and say the split is unknown. Do not pin the time on one of them.
- **Too large for context** (`persisted`): the hook printed more than fits, Claude Code saved it to a file and the model saw a preview of about 2K characters. It is counted at preview size. **Read back** means the agent later opened the whole file with the Read tool. Reads through Bash (`cat`, `sed`) or partial reads are not counted, so read-back is a lower bound, not proof the rest went unused.
- **Identical repeats**: the same text injected again in the same session. Everything after the first copy is overhead.
- **Unattributed**: the transcript does not say which command printed that text. The answer lists the hooks configured for that event instead. Find the owner by searching the preview's first words in those plugins' folders, for example `rg -l "Promoted rules for world" ~/.claude/plugins/cache`.
- **Unavailable is not zero.** "Telemetry unavailable" or "no hook firings" means hook time was not measured; it needs the menu bar app's collector. Injected text still works without it, but owners then read "owner unknown (no telemetry)".
- **Coverage**: sessions whose transcripts are in this machine's Claude config dir (`~/.claude/projects`, or `$CLAUDE_CONFIG_DIR`). Other config dirs and remote hosts are not in the named tools.

## From a finding to a change

| Owner in the answer | Where the change goes |
| --- | --- |
| `plugin <name> (…/hooks/hooks.json)` | `claude plugin disable <name>`, or that plugin's own settings. Never edit the plugin cache: updates overwrite it. |
| `user settings (~/.claude/settings.json)` | that hook's entry under `hooks` in the file |
| `project settings (<repo>/.claude/settings.json)` | that file; it is shared with everyone on the repo |
| `Hindsight by tag` | Hindsight's own settings: its coding-agent hooks read `~/.hindsight/coding-agent.json`. Check Hindsight's docs for option names; they change between versions. |

Report the finding with its numbers, scope and owner, then propose the change. Do not apply it without approval: hooks, settings and plugins change every future session.

## Check that a change helped

SessionStart text and hook changes only show up in a new session, so `current` never shows the effect of a change made during it. After the change, run `harness_summary` for one session from before and one from after (`session: "<id>"`), with similar work in both, and compare.
