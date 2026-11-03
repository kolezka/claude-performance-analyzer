// Builds the MCP server into single-file bundles for the Claude Code plugin.
//
// A plugin install copies the repo and runs no install step, so workspace imports
// (@cpa/analytics, the collector modules) would not resolve there. The plugin runs these
// bundles instead. dist/ is not committed on main: .github/workflows/release-plugin.yml
// builds it onto the `release` branch. Locally: bun run build:plugin.
import { rmSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..", "..");
export const DIST = join(ROOT, "dist", "mcp");

const BUNDLES = [
  { entry: "apps/mcp/src/index.ts", out: "server.js" },
  // Runs each harness_query in its own process; query.ts finds it next to server.js.
  { entry: "apps/mcp/src/query-child.ts", out: "query-child.js" },
];

export async function buildPlugin(outdir = DIST): Promise<string[]> {
  rmSync(outdir, { recursive: true, force: true });
  const written: string[] = [];
  for (const b of BUNDLES) {
    const result = await Bun.build({ entrypoints: [join(ROOT, b.entry)], outdir, target: "bun", naming: b.out });
    if (!result.success) throw new Error(`build of ${b.entry} failed:\n${result.logs.map(String).join("\n")}`);
    written.push(join(outdir, b.out));
  }
  return written;
}

if (import.meta.main) {
  for (const path of await buildPlugin(process.argv[2] ?? DIST)) console.log(`built ${path}`);
}
