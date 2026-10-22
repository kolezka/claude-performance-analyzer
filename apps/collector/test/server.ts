import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Asks the OS for a free port. The collector needs a fixed PORT for its origin check, so port 0 will not do.
export function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

// Runs the collector on a free port with data and settings in a temp dir.
export async function startCollector(env: Record<string, string> = {}) {
  const port = freePort();
  const dir = mkdtempSync(join(tmpdir(), "cc-collector-"));
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: { ...process.env, PORT: String(port), CC_TELEMETRY_DIR: dir, CC_SETTINGS_PATH: join(dir, "settings.json"), NODE_ENV: "production", ...env },
    stdout: "ignore",
    stderr: "inherit",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    // A child that exited lost the port, so whatever answers is some other server.
    if (proc.exitCode !== null) break;
    if ((await fetch(`${url}/api/live`).then((r) => r.ok, () => false)) && proc.exitCode === null) return { port, url, stop: () => proc.kill() };
    await Bun.sleep(100);
  }
  proc.kill();
  throw new Error(`collector did not start (exit code ${proc.exitCode})`);
}

// OTLP fixtures for each signal, as http/json bodies. Resource attributes try to claim a host,
// which must never decide where rows are stored.
const s = (v: string) => ({ stringValue: v });
const spoof = [
  { key: "host_id", value: s("local") },
  { key: "host.id", value: s("local") },
  { key: "host.name", value: s("This Mac") },
];
export function otlpJson(signal: "logs" | "traces" | "metrics", sessionId: string, marker: string) {
  const nowNs = `${Date.now()}000000`;
  if (signal === "logs")
    return {
      resourceLogs: [{
        resource: { attributes: spoof },
        scopeLogs: [{ logRecords: [{ timeUnixNano: nowNs, attributes: [
          { key: "event.name", value: s("tool_result") },
          { key: "session.id", value: s(sessionId) },
          { key: "prompt.id", value: s(`p-${sessionId}`) },
          { key: "tool_name", value: s("Bash") },
          { key: "marker", value: s(marker) },
          { key: "duration_ms", value: { intValue: "7" } },
        ] }] }],
      }],
    };
  if (signal === "traces")
    return {
      resourceSpans: [{
        resource: { attributes: spoof },
        scopeSpans: [{ spans: [{
          traceId: "00000000000000000000000000000001",
          spanId: "0000000000000001",
          name: "claude_code.tool",
          startTimeUnixNano: nowNs,
          endTimeUnixNano: nowNs,
          attributes: [{ key: "session.id", value: s(sessionId) }, { key: "marker", value: s(marker) }],
        }] }],
      }],
    };
  return {
    resourceMetrics: [{
      resource: { attributes: spoof },
      scopeMetrics: [{ metrics: [{ name: "claude_code.cost.usage", sum: { dataPoints: [{
        timeUnixNano: nowNs,
        asDouble: 0.5,
        attributes: [{ key: "session.id", value: s(sessionId) }, { key: "marker", value: s(marker) }],
      }] } }] }],
    }],
  };
}

// The same fixture as http/protobuf bytes. Trace and span ids are bytes on the wire, which
// protobufjs takes as base64 in fromObject.
export function otlpProtobuf(signal: "logs" | "traces" | "metrics", sessionId: string, marker: string, requestType: (s: any) => any): Uint8Array {
  const body: any = otlpJson(signal, sessionId, marker);
  if (signal === "traces") {
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    span.traceId = Buffer.from(span.traceId, "hex").toString("base64");
    span.spanId = Buffer.from(span.spanId, "hex").toString("base64");
  }
  const t = requestType(signal);
  return new Uint8Array(t.encode(t.fromObject(body)).finish());
}
