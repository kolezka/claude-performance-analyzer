import { expect, test } from "bun:test";
import { extractPaths } from "../src";

const HOME = "/Users/joe";

test("extractPaths reads file_path, notebook_path and path from tool_input/tool_parameters", () => {
  expect(extractPaths({ tool_input: JSON.stringify({ file_path: "/abs/file.ts" }) }, HOME)).toEqual(["/abs/file.ts"]);
  expect(extractPaths({ tool_input: JSON.stringify({ notebook_path: "/abs/nb.ipynb" }) }, HOME)).toEqual(["/abs/nb.ipynb"]);
  expect(extractPaths({ tool_parameters: JSON.stringify({ path: "/abs/dir" }) }, HOME)).toEqual(["/abs/dir"]);
});

test("extractPaths follows a leading cd, single or double quoted", () => {
  const dq = { tool_input: JSON.stringify({ command: `cd "/abs/dq path" && ls` }) };
  expect(extractPaths(dq, HOME)).toEqual(["/abs/dq path"]);
  const sq = { tool_parameters: JSON.stringify({ full_command: `cd '/abs/sq path' && ls` }) };
  expect(extractPaths(sq, HOME)).toEqual(["/abs/sq path"]);
  const bare = { tool_input: JSON.stringify({ command: "cd /abs/bare && git status" }) };
  expect(extractPaths(bare, HOME)).toEqual(["/abs/bare"]);
});

test("extractPaths follows git -C anywhere in the command", () => {
  const a = { tool_input: JSON.stringify({ command: "git -C /abs/repo status" }) };
  expect(extractPaths(a, HOME)).toEqual(["/abs/repo"]);
  const chained = { tool_parameters: JSON.stringify({ full_command: "cd /abs/a && git -C /abs/b log" }) };
  expect(extractPaths(chained, HOME)).toEqual(["/abs/a", "/abs/b"]);
});

test("extractPaths expands a leading ~/ using the home parameter", () => {
  const a = { tool_input: JSON.stringify({ file_path: "~/proj/file.ts" }) };
  expect(extractPaths(a, HOME)).toEqual(["/Users/joe/proj/file.ts"]);
});

test("extractPaths ignores relative paths", () => {
  const a = { tool_input: JSON.stringify({ file_path: "relative/file.ts", command: "cd relative/dir" }) };
  expect(extractPaths(a, HOME)).toEqual([]);
});

test("extractPaths tolerates tool_input truncated mid-object", () => {
  const truncated = `{"file_path":"/abs/trunc.ts","other":"…[550 chars]`;
  expect(() => JSON.parse(truncated)).toThrow();
  expect(extractPaths({ tool_input: truncated }, HOME)).toEqual(["/abs/trunc.ts"]);
});

test("extractPaths regex fallback unescapes JSON-escaped quotes in a truncated command", () => {
  const truncated = `${JSON.stringify({ command: 'cd "/abs/space dir" && git status' })} …[500 chars]`;
  expect(() => JSON.parse(truncated)).toThrow();
  expect(extractPaths({ tool_input: truncated }, HOME)).toEqual(["/abs/space dir"]);
});

test("extractPaths stops a bare path at trailing shell punctuation", () => {
  expect(extractPaths({ tool_input: JSON.stringify({ command: "cd /abs/repo; git status" }) }, HOME)).toEqual(["/abs/repo"]);
  expect(extractPaths({ tool_input: JSON.stringify({ command: "cd /abs/pipe|wc -l" }) }, HOME)).toEqual(["/abs/pipe"]);
  expect(extractPaths({ tool_parameters: JSON.stringify({ full_command: "cd /abs/and&&ls" }) }, HOME)).toEqual(["/abs/and"]);
  expect(extractPaths({ tool_input: JSON.stringify({ command: "git -C /abs/gitc)status" }) }, HOME)).toEqual(["/abs/gitc"]);
});
