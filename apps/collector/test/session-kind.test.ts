import { expect, test } from "bun:test";
import { buildSessionInfo } from "../src/sessions";

const LOCAL = { id: "local", home: "/home/me", mayReadDisk: true };

const row = (name: string, tsMs: number, attrs: Record<string, unknown>, sessionId = "sess") => ({ tsMs, name, sessionId, promptId: null, attrs });

test("a session with a repl_main_thread api_request is interactive, labelled with its terminal", () => {
  const info = buildSessionInfo(
    "sess",
    [
      row("api_request", 0, { query_source: "repl_main_thread", model: "claude-sonnet-5" }),
      row("tool_result", 1, { "terminal.type": "iTerm.app" }),
    ],
    LOCAL,
  )!;
  expect(info.kind).toBe("interactive");
  expect(info.kindLabel).toBe("Interactive · iTerm.app");
});

test("interactive with no terminal.type reported falls back to a bare label", () => {
  const info = buildSessionInfo("sess", [row("api_request", 0, { query_source: "repl_main_thread" })], LOCAL)!;
  expect(info.kindLabel).toBe("Interactive");
});

test("an sdk query_source with no repl thread is headless, labelled with the first model seen", () => {
  const info = buildSessionInfo(
    "sess",
    [row("api_request", 0, { query_source: "sdk", model: "claude-haiku-5" }), row("api_request", 1, { query_source: "sdk", model: "claude-opus-5" })],
    LOCAL,
  )!;
  expect(info.kind).toBe("headless");
  expect(info.kindLabel).toBe("Headless (SDK) · claude-haiku-5");
});

test("a non-interactive terminal makes a session headless even without an sdk query_source", () => {
  const info = buildSessionInfo("sess", [row("tool_result", 0, { "terminal.type": "non-interactive" })], LOCAL)!;
  expect(info.kind).toBe("headless");
  expect(info.kindLabel).toBe("Headless (SDK)");
});

test("repl_main_thread wins even alongside an sdk request in the same session", () => {
  const info = buildSessionInfo(
    "sess",
    [row("api_request", 0, { query_source: "sdk" }), row("api_request", 1, { query_source: "repl_main_thread" })],
    LOCAL,
  )!;
  expect(info.kind).toBe("interactive");
});

test("launcher is the first non-empty launcher attr across the session's events, else null", () => {
  const tagged = buildSessionInfo("sess", [row("api_request", 0, { launcher: "" }), row("user_prompt", 1, { launcher: "x" }), row("tool_result", 2, { launcher: "y" })], LOCAL)!;
  expect(tagged.launcher).toBe("x");
  const plain = buildSessionInfo("sess", [row("api_request", 0, { query_source: "sdk" })], LOCAL)!;
  expect(plain.launcher).toBeNull();
});
