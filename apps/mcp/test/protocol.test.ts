import { expect, test } from "bun:test";
import { createServer, PROTOCOL_VERSIONS, serveStdio } from "../src/protocol";

const server = createServer({ name: "t", version: "1" }, [
  { name: "echo", description: "d", inputSchema: { type: "object" }, run: (a) => `got ${a.x}` },
  {
    name: "boom",
    description: "d",
    inputSchema: { type: "object" },
    run: () => {
      throw new Error("bad input");
    },
  },
]);

test("initialize echoes a known protocol version and falls back to the newest otherwise", async () => {
  const known = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  expect(known!.result.protocolVersion).toBe("2025-03-26");
  expect(known!.result.capabilities).toEqual({ tools: { listChanged: false } });
  const unknown = await server.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  expect(unknown!.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
});

test("tools/list and tools/call", async () => {
  const list = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(list!.result.tools.map((t: any) => t.name)).toEqual(["echo", "boom"]);
  const call = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { x: 5 } } });
  expect(call!.result).toEqual({ content: [{ type: "text", text: "got 5" }] });
});

test("a failing tool returns isError with the message; an unknown tool is a protocol error", async () => {
  const boom = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom" } });
  expect(boom!.result).toEqual({ content: [{ type: "text", text: "Error: bad input" }], isError: true });
  const missing = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nope" } });
  expect(missing!.error.code).toBe(-32602);
});

test("unknown methods error only when a reply is expected", async () => {
  expect((await server.handle({ jsonrpc: "2.0", id: 9, method: "resources/list" }))!.error.code).toBe(-32601);
  expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
});

test("serveStdio answers each line in order and reports unparsable lines", async () => {
  const lines = ['{"jsonrpc":"2.0","id":1,"method":"ping"}', "not json", '{"jsonrpc":"2.0","id":2,"method":"tools/list"}', ""].join("\n");
  const input = new Blob([lines]).stream();
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: string) => written.push(s) > 0;
  try {
    await serveStdio(server, input);
  } finally {
    (process.stdout as any).write = original;
  }
  const replies = written.map((s) => JSON.parse(s));
  expect(replies.map((r) => r.id)).toEqual([1, null, 2]);
  expect(replies[1].error.code).toBe(-32700);
});
