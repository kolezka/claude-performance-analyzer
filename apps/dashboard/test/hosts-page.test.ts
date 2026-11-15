import { expect, test } from "bun:test";
import { LOCAL_HOST } from "../src/hosts";
import { confirmText, hostRows } from "../src/pages/hosts/rows";

const now = 1_000_000_000;

test("local host comes first and remotes keep their order", () => {
  const a = { id: "a", name: "box-a", createdMs: now - 60_000, lastSeenMs: now - 5_000 };
  const b = { id: "b", name: "box-b", createdMs: null, lastSeenMs: null };
  const rows = hostRows([a, LOCAL_HOST, b], now);
  expect(rows.map((r) => r.host.id)).toEqual(["local", "a", "b"]);
  expect(rows[0]!.local).toBe(true);
  expect(rows[1]!.waiting).toBe(false);
  expect(rows[1]!.detail).toStartWith("last seen");
  expect(rows[2]!.waiting).toBe(true);
  expect(rows[2]!.detail).toBe("no telemetry yet");
});

test("a waiting host with a creation time says when it was added", () => {
  const rows = hostRows([{ id: "c", name: "c", createdMs: now, lastSeenMs: null }], now);
  expect(rows[0]!.detail).toStartWith("added ");
  expect(rows[0]!.detail).toEndWith(", no telemetry yet");
});

test("no hosts gives no rows", () => {
  expect(hostRows([], now)).toEqual([]);
});

test("confirm text names the host and the consequence", () => {
  expect(confirmText({ id: "a", action: "rotate" }, "box")).toContain("stops working");
  expect(confirmText({ id: "a", action: "remove" }, "box")).toContain("deleted");
});
