// Who may send telemetry. The peer address comes from the socket (server.requestIP), never a
// header; the token decides which host the data belongs to.
import { hashToken, LOCAL_HOST_ID } from "./hosts";
import type { Store } from "./db";

export type Peer = "loopback" | "tailscale" | "other";

function parseIPv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

// Eight 16-bit groups, or null. Handles "::" compression and a dotted IPv4 tail.
function parseIPv6(text: string): number[] | null {
  if (!text.includes(":")) return null;
  let head = text;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    head = text.slice(0, lastColon + 1);
    // "::1.2.3.4" leaves "::", "a::1.2.3.4" leaves "a::", "a:b:c:d:e:f:1.2.3.4" leaves "a:...:f:".
    if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const groups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const left = groups(halves[0]!);
  const right = halves.length === 2 ? groups(halves[1]!) : [];
  if (!left || !right) return null;
  const known = left.length + right.length + tail.length;
  if (halves.length === 2) {
    if (known > 7) return null;
    return [...left, ...new Array(8 - known).fill(0), ...right, ...tail];
  }
  return known === 8 ? [...left, ...tail] : null;
}

function classifyIPv4(v4: number[]): Peer {
  if (v4[0] === 127) return "loopback";
  // 100.64.0.0/10: second octet 64..127.
  if (v4[0] === 100 && v4[1]! >= 64 && v4[1]! <= 127) return "tailscale";
  return "other";
}

export function classifyPeer(address: string | null): Peer {
  if (!address) return "other";
  const v4 = parseIPv4(address);
  if (v4) return classifyIPv4(v4);
  const v6 = parseIPv6(address);
  if (!v6) return "other";
  if (v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1) return "loopback";
  // IPv4-mapped ::ffff:a.b.c.d, which a dual-stack listener reports for IPv4 clients.
  if (v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff) {
    return classifyIPv4([v6[6]! >> 8, v6[6]! & 0xff, v6[7]! >> 8, v6[7]! & 0xff]);
  }
  // fd7a:115c:a1e0::/48
  if (v6[0] === 0xfd7a && v6[1] === 0x115c && v6[2] === 0xa1e0) return "tailscale";
  return "other";
}

const deny = (status: 401 | 403, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

// Loopback without a token is this Mac. Anything carrying a token must carry a valid one, even
// on loopback. Peers outside loopback and Tailscale are refused before any token lookup.
export function authorizeIngest(address: string | null, authorization: string | null, store: Pick<Store, "hostForTokenHash">): { hostId: string } | Response {
  const peer = classifyPeer(address);
  if (peer === "other") return deny(403, "forbidden");
  if (authorization === null) return peer === "loopback" ? { hostId: LOCAL_HOST_ID } : deny(401, "missing token");
  const m = authorization.match(/^Bearer\s+(\S+)\s*$/i);
  if (!m) return deny(401, "invalid token");
  const host = store.hostForTokenHash(hashToken(m[1]!));
  return host ? { hostId: host.id } : deny(401, "invalid token");
}
