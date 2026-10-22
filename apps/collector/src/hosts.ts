// Remote host identity: tokens, their hashes and the context that says whether enrichment may
// read this Mac's disk for a host's telemetry.
import { createHash } from "node:crypto";
import { homedir } from "node:os";

export const LOCAL_HOST_ID = "local";

export interface Host {
  id: string;
  name: string;
  createdMs: number | null;
  lastSeenMs: number | null;
}

export interface HostCredentials {
  host: Host;
  token: string;
  env: Record<string, string>;
  tailscaleAddress: string | null;
}

export interface HostContext {
  id: string;
  home: string | null;
  mayReadDisk: boolean;
}

export const LOCAL_HOST: Host = { id: LOCAL_HOST_ID, name: "This Mac", createdMs: null, lastSeenMs: null };

// Remote paths are kept as sent: their home is unknown, and this Mac's disk says nothing about them.
export function hostContext(id: string): HostContext {
  return id === LOCAL_HOST_ID ? { id, home: homedir(), mayReadDisk: true } : { id, home: null, mayReadDisk: false };
}

export function createToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `cpa_${Buffer.from(bytes).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
