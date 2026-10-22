import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeIngest, classifyPeer } from "../src/access";
import { openStore } from "../src/db";
import { createToken, hashToken } from "../src/hosts";

test("classifyPeer: loopback forms", () => {
  for (const a of ["127.0.0.1", "127.255.255.254", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:127.0.0.1"]) {
    expect([a, classifyPeer(a)]).toEqual([a, "loopback"]);
  }
});

test("classifyPeer: Tailscale v4 range boundaries", () => {
  for (const a of ["100.64.0.0", "100.64.0.1", "100.100.100.100", "100.127.255.255", "::ffff:100.64.0.1", "::ffff:6440:1"]) {
    expect([a, classifyPeer(a)]).toEqual([a, "tailscale"]);
  }
  for (const a of ["100.63.255.255", "100.128.0.0", "100.0.0.1", "10.0.0.1", "192.168.1.10", "::ffff:100.128.0.1"]) {
    expect([a, classifyPeer(a)]).toEqual([a, "other"]);
  }
});

test("classifyPeer: Tailscale v6 in compressed and expanded form", () => {
  for (const a of ["fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12:4843:cd96:6258:b240", "FD7A:115C:A1E0::abcd", "fd7a:115c:a1e0:0:0:0:0:1", "fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff"]) {
    expect([a, classifyPeer(a)]).toEqual([a, "tailscale"]);
  }
  // A textual prefix match would wrongly accept the first two.
  for (const a of ["fd7a:115c:a1e01::1", "fd7a:115c:a1e:0::1", "fd7a:115c:a1e1::1", "fd7a:115c::1", "fe80::1", "2001:db8::1", "::"]) {
    expect([a, classifyPeer(a)]).toEqual([a, "other"]);
  }
});

test("classifyPeer: malformed, empty and null addresses are other", () => {
  for (const a of [null, "", "localhost", "127.0.0.1.1", "256.1.1.1", "100.64.0", "1::2::3", "fd7a:115c:a1e0::1::", "::ffff:999.0.0.1", "127.0.0.01x", "gggg::1"]) {
    expect([a, classifyPeer(a)]).toEqual([a, "other"]);
  }
});

function setup() {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "cc-access-")), "t.sqlite"));
  const token = createToken();
  const host = store.createHost("remote", hashToken(token), 1);
  return { store, token, host };
}

const status = (r: unknown) => (r instanceof Response ? r.status : r);

test("loopback without a token is the local host", () => {
  const { store } = setup();
  expect(authorizeIngest("127.0.0.1", null, store)).toEqual({ hostId: "local" });
  expect(authorizeIngest("::1", null, store)).toEqual({ hostId: "local" });
  expect(authorizeIngest("::ffff:127.0.0.1", null, store)).toEqual({ hostId: "local" });
});

test("a valid bearer token on loopback tags the remote host; an invalid one is 401", () => {
  const { store, token, host } = setup();
  expect(authorizeIngest("127.0.0.1", `Bearer ${token}`, store)).toEqual({ hostId: host.id });
  expect(status(authorizeIngest("127.0.0.1", "Bearer cpa_wrong", store))).toBe(401);
  expect(status(authorizeIngest("127.0.0.1", "Basic abc", store))).toBe(401);
  expect(status(authorizeIngest("127.0.0.1", "", store))).toBe(401);
});

test("Tailscale peers need a valid token", () => {
  const { store, token, host } = setup();
  expect(authorizeIngest("100.64.0.9", `Bearer ${token}`, store)).toEqual({ hostId: host.id });
  expect(authorizeIngest("fd7a:115c:a1e0::9", `bearer ${token}`, store)).toEqual({ hostId: host.id });
  expect(status(authorizeIngest("100.64.0.9", null, store))).toBe(401);
  expect(status(authorizeIngest("100.64.0.9", `Bearer ${token}x`, store))).toBe(401);
  expect(status(authorizeIngest("100.64.0.9", token, store))).toBe(401);
});

test("peers outside Tailscale get 403 even with a valid token, and a missing address fails closed", async () => {
  const { store, token } = setup();
  for (const a of ["192.168.1.5", "8.8.8.8", "fe80::1", null]) {
    const r = authorizeIngest(a, `Bearer ${token}`, store);
    expect([a, status(r)]).toEqual([a, 403]);
    expect(JSON.stringify(await (r as Response).json())).not.toContain(token);
  }
});

test("rotated or removed tokens stop working at once", () => {
  const { store, token, host } = setup();
  const next = createToken();
  store.rotateHostToken(host.id, hashToken(next));
  expect(status(authorizeIngest("100.64.0.9", `Bearer ${token}`, store))).toBe(401);
  expect(authorizeIngest("100.64.0.9", `Bearer ${next}`, store)).toEqual({ hostId: host.id });
  store.removeHost(host.id);
  expect(status(authorizeIngest("100.64.0.9", `Bearer ${next}`, store))).toBe(401);
});
