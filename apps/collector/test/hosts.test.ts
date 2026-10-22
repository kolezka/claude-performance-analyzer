import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/db";
import { createToken, hashToken, hostContext, LOCAL_HOST } from "../src/hosts";

const store = () => openStore(join(mkdtempSync(join(tmpdir(), "cc-hosts-")), "t.sqlite"));

test("tokens are cpa_ plus 32 random bytes in base64url, hashed with SHA-256", () => {
  const a = createToken();
  const b = createToken();
  expect(a).toMatch(/^cpa_[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(a.slice(4), "base64url")).toHaveLength(32);
  expect(a).not.toBe(b);
  expect(hashToken(a)).toBe(new Bun.CryptoHasher("sha256").update(a).digest("hex"));
  expect(hashToken(a)).not.toBe(hashToken(b));
});

test("host contexts: local reads this Mac, remote never does", () => {
  expect(hostContext("local")).toEqual({ id: "local", home: homedir(), mayReadDisk: true });
  expect(hostContext("abc")).toEqual({ id: "abc", home: null, mayReadDisk: false });
  expect(LOCAL_HOST).toEqual({ id: "local", name: "This Mac", createdMs: null, lastSeenMs: null });
});

test("registry stores only a hash and never returns it", () => {
  const s = store();
  const token = createToken();
  const host = s.createHost("linux-box", hashToken(token), 1234);
  expect(host).toEqual({ id: expect.any(String), name: "linux-box", createdMs: 1234, lastSeenMs: null });
  expect(host.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(s.hosts()).toEqual([host]);
  expect(s.host(host.id)).toEqual(host);
  expect(s.host("local")).toBeNull();
  expect(s.host("nope")).toBeNull();
  const projections = JSON.stringify([s.hosts(), s.host(host.id)]);
  expect(projections).not.toContain(token);
  expect(projections).not.toContain(hashToken(token));
  // Plaintext never reaches the database.
  const dump = JSON.stringify(s.db.query("SELECT * FROM hosts").all());
  expect(dump).not.toContain(token);
  expect(s.hostForTokenHash(hashToken(token))).toEqual(host);
  expect(s.hostForTokenHash(hashToken(createToken()))).toBeNull();
  expect(s.hostForTokenHash("not-a-hash")).toBeNull();
});

test("names are unique and hosts list in creation order", () => {
  const s = store();
  const a = s.createHost("a", hashToken(createToken()), 1);
  const b = s.createHost("b", hashToken(createToken()), 2);
  expect(() => s.createHost("a", hashToken(createToken()), 3)).toThrow();
  expect(s.hosts().map((h) => h.id)).toEqual([a.id, b.id]);
});

test("rotation invalidates the old token at once", () => {
  const s = store();
  const old = createToken();
  const host = s.createHost("mac-mini", hashToken(old), 1);
  const next = createToken();
  expect(s.rotateHostToken(host.id, hashToken(next))).toBe(true);
  expect(s.hostForTokenHash(hashToken(old))).toBeNull();
  expect(s.hostForTokenHash(hashToken(next))?.id).toBe(host.id);
  expect(s.rotateHostToken("missing", hashToken(next))).toBe(false);
  expect(s.rotateHostToken("local", hashToken(next))).toBe(false);
});

test("touchHost records last seen", () => {
  const s = store();
  const host = s.createHost("x", hashToken(createToken()), 1);
  s.touchHost(host.id, 5000);
  expect(s.host(host.id)?.lastSeenMs).toBe(5000);
});

function seed(s: ReturnType<typeof store>, hostId: string) {
  const now = Date.now();
  s.addEvents([{ tsMs: now, name: "tool_result", sessionId: "S", promptId: "P", attrs: {} }], hostId);
  s.addSpans([{ traceId: "t", spanId: "s", parentId: null, name: "x", startMs: now, endMs: now, sessionId: "S", attrs: {} }], hostId);
  s.addMetrics([{ tsMs: now, name: "m", sessionId: "S", value: 1, attrs: {} }], hostId);
}

const counts = (s: ReturnType<typeof store>) =>
  Object.fromEntries(
    ["events", "spans", "metrics"].map((t) => [t, s.db.query(`SELECT host_id, COUNT(*) AS n FROM ${t} GROUP BY host_id ORDER BY host_id`).all()]),
  );

test("removing a host deletes its registry row and all its telemetry, nothing else", () => {
  const s = store();
  const token = createToken();
  const gone = s.createHost("gone", hashToken(token), 1);
  const kept = s.createHost("kept", hashToken(createToken()), 2);
  seed(s, "local");
  seed(s, gone.id);
  seed(s, kept.id);
  expect(s.removeHost(gone.id)).toBe(true);
  expect(s.host(gone.id)).toBeNull();
  expect(s.hostForTokenHash(hashToken(token))).toBeNull();
  const expected = [{ host_id: kept.id, n: 1 }, { host_id: "local", n: 1 }].sort((a, b) => a.host_id.localeCompare(b.host_id));
  expect(counts(s)).toEqual({ events: expected, spans: expected, metrics: expected });
  expect(s.removeHost(gone.id)).toBe(false);
  expect(s.removeHost("local")).toBe(false);
  expect(counts(s).events).toEqual(expected);
});

test("a removal rolled back by its caller keeps registry and telemetry", () => {
  const s = store();
  const host = s.createHost("h", hashToken(createToken()), 1);
  seed(s, host.id);
  const before = counts(s);
  expect(() =>
    s.db.transaction(() => {
      s.removeHost(host.id);
      throw new Error("bind failed");
    })(),
  ).toThrow("bind failed");
  expect(s.host(host.id)).toEqual(host);
  expect(counts(s)).toEqual(before);
});
