// Compiles the collector and the dashboard into one standalone executable, so the menu bar
// app can ship it without Bun or this repository on the user's machine.
// Usage: bun scripts/compile.ts <bun-darwin-arm64|bun-darwin-x64> <outfile>
import { SveltePlugin } from "bun-plugin-svelte";

const [target, outfile] = process.argv.slice(2);
if (!target || !outfile) {
  console.error("usage: bun scripts/compile.ts <target> <outfile>");
  process.exit(1);
}

const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/../src/index.ts`],
  compile: { target: target as Bun.Build.CompileTarget, outfile },
  // bunfig's serve.static plugin only applies to `bun run`, so the bundler needs it here too.
  plugins: [SveltePlugin()],
  minify: true,
  // launchd starts the binary with an empty environment, which would mean development mode.
  define: { "process.env.NODE_ENV": '"production"' },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
