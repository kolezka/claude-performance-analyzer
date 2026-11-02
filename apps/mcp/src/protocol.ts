// A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0 with the tools capability.
// stdout carries protocol messages only; anything else goes to stderr.

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string> | string;
}

export interface ServerInfo {
  name: string;
  version: string;
  instructions?: string;
}

// Versions this server has been written against. A client asking for one of them gets it back;
// anything else gets the newest, and the client decides whether it can work with that.
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type Json = Record<string, any>;

function reply(id: unknown, result: unknown): Json {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: unknown, code: number, message: string): Json {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export function createServer(info: ServerInfo, tools: ToolDef[]) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  async function handle(msg: unknown): Promise<Json | null> {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return fail(null, -32600, "Invalid request");
    const { id, method, params } = msg as Json;
    const isNotification = id === undefined;
    if (typeof method !== "string") return isNotification ? null : fail(id, -32600, "Invalid request");

    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        const protocolVersion = typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: info.name, version: info.version },
          ...(info.instructions ? { instructions: info.instructions } : {}),
        });
      }
      case "ping":
        return isNotification ? null : reply(id, {});
      case "tools/list":
        return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const tool = byName.get(params?.name);
        if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
        const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
        try {
          const text = await tool.run(args);
          return reply(id, { content: [{ type: "text", text }] });
        } catch (err) {
          return reply(id, { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true });
        }
      }
      default:
        if (isNotification) return null;
        return fail(id, -32601, `Method not found: ${method}`);
    }
  }

  return { handle };
}

export type Server = ReturnType<typeof createServer>;

// Reads newline-delimited JSON-RPC from stdin and answers on stdout, one request at a time so
// responses keep their order.
export async function serveStdio(server: Server, input: ReadableStream<Uint8Array> = Bun.stdin.stream()) {
  const decoder = new TextDecoder();
  let buffer = "";
  const write = (msg: Json) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        write(fail(null, -32700, "Parse error"));
        continue;
      }
      const res = await server.handle(msg);
      if (res) write(res);
    }
  }
}
