import { expect, test } from "bun:test";
import { join } from "node:path";

// A host mutation moves the listener inside its SQLite transaction. If the commit then fails
// (a real disk error, injected in a disposable child), the listener must go back to the mode
// that matches the rolled-back data, the error must surface, and a failed restore is fatal.
test.skipIf(process.platform !== "darwin")("a failed commit after a rebind restores the listener or fails fatally", async () => {
  const child = Bun.spawn(["bun", join(import.meta.dir, "fixtures/commit-fault.ts")], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect([code, err.includes("Error") && code !== 0 ? err : ""]).toEqual([0, ""]);
  const results = out.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  const find = (action: string, fault: boolean, restoreFails: boolean) => results.find((r) => r.action === action && r.fault === fault && r.restoreFails === restoreFails);

  // Positive controls: the mutation commits and the listener follows it.
  expect(find("delete", false, false)).toMatchObject({ status: 204, error: null, hosts: [], remoteEnabled: false, ipv6: "refused", rebinds: [false], fatal: 0 });
  expect(find("add", false, false)).toMatchObject({ status: 201, error: null, hosts: ["new"], remoteEnabled: true, ipv6: 200, rebinds: [true], fatal: 0 });

  // Commit fails: data rolls back, the listener goes back with it, the disk error surfaces.
  const del = find("delete", true, false);
  expect(del).toMatchObject({ status: null, hosts: ["remote"], rows: ["retained-row"], remoteEnabled: true, ipv6: 200, rebinds: [false, true], fatal: 0 });
  expect(del.error).toContain("disk I/O error");
  const add = find("add", true, false);
  expect(add).toMatchObject({ status: null, hosts: [], remoteEnabled: false, ipv6: "refused", rebinds: [true, false], fatal: 0 });
  expect(add.error).toContain("disk I/O error");

  // Commit fails and the restore fails too: never success, 500, and the fatal hook fires.
  for (const action of ["delete", "add"]) {
    const r = find(action, true, true);
    expect([action, r.status, r.error, r.fatal]).toEqual([action, 500, null, 1]);
    expect(r.responseBody).toEqual({ error: expect.any(String) });
    expect(r.hosts).toEqual(action === "delete" ? ["remote"] : []);
  }
}, 60_000);
