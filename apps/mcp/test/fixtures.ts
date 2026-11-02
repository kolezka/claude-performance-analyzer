// Transcript lines in the key order Claude Code writes them (top-level keys before "message"
// for user lines, "message" before "type" for assistant lines), plus a temp environment.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@cpa/collector/src/db";
import type { EventRow } from "@cpa/otlp";

export const SID = "11111111-2222-3333-4444-555555555555";
export const CWD = "/work/demo";
export const T0 = Date.parse("2026-11-02T10:00:00.000Z");

const iso = (ms: number) => new Date(ms).toISOString();

export function modeLine(): string {
  return JSON.stringify({ type: "mode", mode: "normal", sessionId: SID });
}

export function promptLine(promptId: string, text: string, tsMs: number): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    promptId,
    type: "user",
    message: { role: "user", content: text },
    uuid: `u-${promptId}`,
    timestamp: iso(tsMs),
    sessionId: SID,
    cwd: CWD,
  });
}

export function attachmentLine(attachment: Record<string, unknown>, tsMs: number, sessionId = SID): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    attachment,
    type: "attachment",
    uuid: `a-${tsMs}`,
    timestamp: iso(tsMs),
    sessionId,
    cwd: CWD,
    gitBranch: "main",
  });
}

export function hookSuccess(hookEvent: string, command: string, stdout: string, durationMs: number, tsMs: number): string {
  return attachmentLine(
    { type: "hook_success", hookName: `${hookEvent}:startup`, hookEvent, content: "", command, durationMs, exitCode: 0, stdout, stderr: "" },
    tsMs,
  );
}

export function hookContext(hookEvent: string, content: string[], tsMs: number, hookName = hookEvent): string {
  return attachmentLine({ type: "hook_additional_context", hookName, hookEvent, content }, tsMs);
}

export function readLine(path: string, tsMs: number): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: path } }] },
    type: "assistant",
    uuid: `r-${tsMs}`,
    timestamp: iso(tsMs),
    sessionId: SID,
  });
}

export function persistedBlock(size: string, path: string, preview: string): string {
  return `<persisted-output>\nOutput too large (${size}). Full output saved to: ${path}\n\nPreview (first 2KB):\n${preview}\n...\n</persisted-output>`;
}

export const SESSION_START_CMD = "node /opt/hindsight/claude-sessionstart-hook.js";
export const PERSISTED_PATH = "/tmp/fixture/tool-results/hook-abc-additionalContext.txt";
export const REFRESH = "<hindsight_knowledge_refresh>\n42 knowledge pages cover this repository.\n</hindsight_knowledge_refresh>";
export const RULES = "Promoted rules for world default:\n- rule one\n- rule two";

// A session: SessionStart with one attributable block and one that no recorded run printed,
// two prompts that both get the same Hindsight refresh, a persisted recall the agent reads
// back, and a Stop hook that blocks.
export function sessionTranscript(): string {
  const knowledge = "<hindsight_knowledge>\nThis repository has a Hindsight memory.\n</hindsight_knowledge>";
  return [
    modeLine(),
    hookSuccess("SessionStart", SESSION_START_CMD, JSON.stringify({ systemMessage: "hi", hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: knowledge } }), 1200, T0 + 100),
    hookContext("SessionStart", [knowledge, RULES], T0 + 200),
    promptLine("p1", "first prompt", T0 + 1_000),
    hookContext("UserPromptSubmit", [persistedBlock("12.8KB", PERSISTED_PATH, "<hindsight_memory>\nrecalled fact\n</hindsight_memory>"), REFRESH], T0 + 1_100),
    readLine(PERSISTED_PATH, T0 + 2_000),
    attachmentLine({ type: "hook_blocking_error", hookName: "Stop", hookEvent: "Stop", blockingError: { blockingError: "Run the checks first.", command: "sh stop-guard.sh" } }, T0 + 3_000),
    promptLine("p2", "second prompt", T0 + 60_000),
    hookContext("UserPromptSubmit", [REFRESH], T0 + 60_100),
    // A hook line cut short, as when the file is read mid-write. Unrelated junk is never parsed.
    hookContext("UserPromptSubmit", ["cut"], T0 + 70_000).slice(0, -12),
    "{not json",
    "",
  ].join("\n");
}

export interface TempEnv {
  claudeDir: string;
  telemetryDir: string;
  restore(): void;
}

// Points the transcript, settings and telemetry lookups at fresh temp folders.
export function tempEnv(): TempEnv {
  const root = mkdtempSync(join(tmpdir(), "cpa-mcp-"));
  const claudeDir = join(root, "claude");
  const telemetryDir = join(root, "telemetry");
  mkdirSync(join(claudeDir, "projects"), { recursive: true });
  mkdirSync(telemetryDir, { recursive: true });
  const saved = { c: process.env.CC_CLAUDE_DIR, t: process.env.CC_TELEMETRY_DIR };
  process.env.CC_CLAUDE_DIR = claudeDir;
  process.env.CC_TELEMETRY_DIR = telemetryDir;
  return {
    claudeDir,
    telemetryDir,
    restore() {
      for (const [k, v] of [
        ["CC_CLAUDE_DIR", saved.c],
        ["CC_TELEMETRY_DIR", saved.t],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

export function writeTranscript(env: TempEnv, projectFolder: string, sessionId: string, text: string): string {
  const dir = join(env.claudeDir, "projects", projectFolder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, text);
  return path;
}

export function hookFiring(sessionId: string, tsMs: number, hookName: string, hookEvent: string, ms: number, extra: Record<string, unknown> = {}): EventRow {
  return {
    tsMs,
    name: "hook_execution_complete",
    sessionId,
    promptId: null,
    attrs: { hook_event: hookEvent, hook_name: hookName, total_duration_ms: String(ms), num_hooks: "1", num_non_blocking_error: "0", num_blocking: "0", num_cancelled: "0", additional_context_chars: "0", ...extra },
  };
}

export function writeTelemetry(env: TempEnv, events: EventRow[]): void {
  const store = openStore(join(env.telemetryDir, "telemetry.sqlite"));
  store.addEvents(events);
  store.db.close();
}

export function writeUserSettingsHook(env: TempEnv, hookEvent: string, command: string): void {
  writeFileSync(join(env.claudeDir, "settings.json"), JSON.stringify({ hooks: { [hookEvent]: [{ hooks: [{ type: "command", command }] }] } }));
}
