// The plugin runs the dist/ bundles, not the source. This builds them and drives the bundled
// server over stdio, so a bundling gap (an unresolved import, the query child not found next
// to server.js) fails here instead of in someone's installed plugin.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlugin } from "../scripts/build";
import { SID, sessionTranscript, tempEnv, writeTranscript, type TempEnv } from "./fixtures";

let env: TempEnv;
beforeEach(() => {
  env = tempEnv();
});
afterEach(() => env.restore());

test("the bundled server answers over stdio, harness_query included", async () => {
  const outdir = mkdtempSync(join(tmpdir(), "cpa-mcp-dist-"));
  const [server] = await buildPlugin(outdir);
  writeTranscript(env, "-work-demo", SID, sessionTranscript());

  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "harness_summary", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "harness_query", arguments: { sql: "SELECT count(*) AS n FROM blocks" } } },
  ];
  // Run from an unrelated folder so nothing resolves through the repo's node_modules.
  const proc = Bun.spawn([process.execPath, server!], {
    cwd: outdir,
    stdin: new Blob([requests.map((r) => JSON.stringify(r)).join("\n") + "\n"]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: SID },
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ code, err }).toEqual({ code: 0, err: "" });

  const replies = new Map(out.trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.id, r]));
  expect(replies.get(1).result.serverInfo.name).toBe("cpa-harness");
  expect(replies.get(2).result.tools.map((t: any) => t.name)).toEqual(["harness_summary", "hook_time", "injected_context", "memory_cost", "harness_query"]);
  expect(replies.get(3).result.content[0].text).toContain(`Session ${SID}`);
  expect(replies.get(4).result).toEqual({ content: [{ type: "text", text: "n\n6" }] });
}, 30_000);
