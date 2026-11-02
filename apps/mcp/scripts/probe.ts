// Calls one tool directly and prints its answer and how long it took. For local checks only:
//   bun apps/mcp/scripts/probe.ts <tool> '<json args>'
import { harnessTools } from "../src/tools";

const [name = "harness_summary", raw = "{}"] = process.argv.slice(2);
const tool = harnessTools().find((t) => t.name === name);
if (!tool) throw new Error(`unknown tool ${name}`);
const started = performance.now();
const text = await tool.run(JSON.parse(raw));
const ms = performance.now() - started;
console.log(text);
Bun.gc(true);
const heapMb = Math.round(process.memoryUsage().heapUsed / 1e6);
console.error(`\n[${name} took ${Math.round(ms)}ms, rss ${Math.round(process.memoryUsage().rss / 1e6)}MB, heap after gc ${heapMb}MB]`);
