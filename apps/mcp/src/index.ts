#!/usr/bin/env bun
// Stdio MCP server: lets a coding agent ask what its Claude Code harness costs.
import { createServer, serveStdio } from "./protocol";
import { harnessTools } from "./tools";

const server = createServer(
  {
    name: "cpa-harness",
    version: "0.1.0",
    instructions:
      "Read-only answers about what the Claude Code harness costs this session or recent sessions: hook time, text hooks inject into context, Hindsight memory share. Call harness_summary first.",
  },
  harnessTools(),
);

await serveStdio(server);
