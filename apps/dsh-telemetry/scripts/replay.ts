// Replays recorded DSH sessions through the same mapper the live plugin uses.
// Imports history and checks the mapping against real logs.
//   bun apps/dsh-telemetry/scripts/replay.ts [--since 2026-11-01] [--dry] [--endpoint http://127.0.0.1:4318] [session dirs...]
import { Glob } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";
import { Exporter } from "../src/exporter.js";
import { logsUrl, parseHeaders } from "../src/index.js";
import { SessionMapper } from "../src/map.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const dry = args.includes("--dry");
if (dry) args.splice(args.indexOf("--dry"), 1);
const since = flag("--since");
const endpoint = flag("--endpoint") ?? process.env.CPA_OTLP_ENDPOINT ?? "http://127.0.0.1:4318";
const sinceMs = since ? Date.parse(since) : 0;

const root = join(homedir(), ".dsh", "sessions");
const files = args.length
  ? args.map((d) => (d.endsWith(".zstd") ? d : join(d, "session.v4.jsonl.zstd")))
  : Array.from(new Glob("*/session-*/session.v4.jsonl.zstd").scanSync({ cwd: root, absolute: true }));

const exporter = dry ? null : new Exporter({ url: logsUrl(endpoint), headers: parseHeaders(process.env.CPA_OTLP_HEADERS), intervalMs: 60_000 });
const counts = new Map<string, number>();
let sessions = 0;
let records = 0;

for (const file of files) {
  const text = new TextDecoder().decode(Bun.zstdDecompressSync(await Bun.file(file).bytes()));
  const lines = text.split("\n").filter(Boolean);
  const header = JSON.parse(lines[0] ?? "{}");
  if (header.type !== "session" || (header.createdAt ?? 0) < sinceMs) continue;
  sessions++;
  const mapper = new SessionMapper(header);
  const batch = [];
  for (const line of lines.slice(1)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const r of mapper.map(event)) {
      batch.push(r);
      counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
    }
  }
  records += batch.length;
  if (exporter) {
    // Push in chunks so one huge session cannot hit the queue cap.
    for (let i = 0; i < batch.length; i += 2000) {
      exporter.push(mapper.resource(), batch.slice(i, i + 2000));
      await exporter.flush();
    }
  }
}
await exporter?.shutdown();

console.log(`${sessions} sessions, ${records} records${dry ? " (dry run)" : ` sent to ${logsUrl(endpoint)}`}`);
for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(8)}  ${name}`);
