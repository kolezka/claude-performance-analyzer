// Host selection, race-safe requests and host management calls shared by the dashboard components.
import type { LiveEvent } from "@cpa/analytics";
import { fmtMs } from "@cpa/analytics";

export type Host = { id: string; name: string; createdMs: number | null; lastSeenMs: number | null };
export type HostCredentials = {
  host: Host;
  token: string;
  env: Record<string, string>;
  tailscaleAddress: string | null;
};

export const LOCAL_HOST_ID = "local";
export const LOCAL_HOST: Host = { id: LOCAL_HOST_ID, name: "This Mac", createdMs: null, lastSeenMs: null };

type FetchFn = typeof fetch;

export function hostFromSearch(search: string): string {
  return new URLSearchParams(search).get("host") || LOCAL_HOST_ID;
}

// Local is the default, so it leaves no host param behind.
export function searchWithHost(search: string, hostId: string): string {
  const params = new URLSearchParams(search);
  if (hostId === LOCAL_HOST_ID) params.delete("host");
  else params.set("host", hostId);
  const out = params.toString();
  return out ? `?${out}` : "";
}

export function apiUrl(path: string, hostId: string, params: Record<string, string | number | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  q.set("host", hostId);
  return `${path}?${q}`;
}

// A null list means the fetch failed: keep the selection rather than guessing it was deleted.
export function reconcileSelection(selected: string, hosts: Host[] | null): string {
  if (!hosts) return selected;
  return hosts.some((h) => h.id === selected) ? selected : LOCAL_HOST_ID;
}

export function hostName(hosts: Host[], id: string): string {
  return hosts.find((h) => h.id === id)?.name ?? (id === LOCAL_HOST_ID ? LOCAL_HOST.name : id);
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (body && typeof body.error === "string") return body.error;
  } catch {}
  return `${res.status} ${res.statusText}`.trim();
}

export type Result<T> = { ok: true; value: T } | { ok: false; status: number | null; error: string };

// Requests tied to the current host. invalidate() aborts them, and the generation check drops
// any answer that still arrives, so an old host's numbers never land under a new host label.
export class RequestGate {
  generation = 0;
  private controllers = new Set<AbortController>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  invalidate(): number {
    this.generation++;
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.generation;
  }

  // Coalesces bursts: a call while one is queued is ignored. invalidate() cancels the queued call.
  soon(fn: () => void, ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, ms);
  }

  // Calls ok or fail only while the request is current, in the same step as the check, so
  // nothing can switch hosts between them. Resolves false when the answer went stale.
  async run<T>(fetchFn: FetchFn, url: string, commit: Commit<T>, init: RequestInit = {}): Promise<boolean> {
    const gen = this.generation;
    const controller = new AbortController();
    this.controllers.add(controller);
    let outcome: Result<T>;
    try {
      const res = await fetchFn(url, { ...init, signal: controller.signal });
      if (gen !== this.generation) return false;
      outcome = res.ok ? { ok: true, value: (await res.json()) as T } : { ok: false, status: res.status, error: await errorMessage(res) };
    } catch (err) {
      outcome = { ok: false, status: null, error: String(err) };
    } finally {
      this.controllers.delete(controller);
    }
    if (gen !== this.generation) return false;
    if (outcome.ok) commit.ok?.(outcome.value);
    else commit.fail?.(outcome.error, outcome.status);
    return true;
  }
}

export type Commit<T> = { ok?: (value: T) => void; fail?: (error: string, status: number | null) => void };

export type LiveMessage = { events: LiveEvent[]; changed: number };

// The socket carries every host; only the selected one gets through.
export function liveForHost(raw: string, hostId: string): LiveMessage | null {
  let data: { type?: unknown; host?: unknown; events?: unknown; changed?: unknown };
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || data.type !== "events" || data.host !== hostId || !Array.isArray(data.events)) return null;
  return { events: data.events as LiveEvent[], changed: Number(data.changed) || 0 };
}

// Hooks that started but have not completed yet, keyed by session and hook name.
export class RunningHooks {
  private inFlight = new Map<string, number>();
  constructor(private staleMs: number) {}

  track(events: LiveEvent[]): void {
    for (const e of events) {
      const key = `${e.sessionId}|${e.label}`;
      if (e.kind === "hook_start") this.inFlight.set(key, e.tsMs);
      else if (e.kind === "hook") this.inFlight.delete(key);
    }
  }

  clear(): void {
    this.inFlight.clear();
  }

  entries(now: number): [string, number][] {
    for (const [k, t] of this.inFlight) if (now - t > this.staleMs) this.inFlight.delete(k);
    return [...this.inFlight];
  }
}

async function send<T>(fetchFn: FetchFn, url: string, method: string, body: unknown, expect: number): Promise<T | null> {
  const res = await fetchFn(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.status !== expect) throw new Error(await errorMessage(res));
  return expect === 204 ? null : ((await res.json()) as T);
}

export async function createHost(fetchFn: FetchFn, name: string): Promise<HostCredentials> {
  return (await send<HostCredentials>(fetchFn, "/api/hosts", "POST", { name }, 201))!;
}

export async function regenerateHostToken(fetchFn: FetchFn, id: string): Promise<HostCredentials> {
  return (await send<HostCredentials>(fetchFn, `/api/hosts/${encodeURIComponent(id)}/token`, "POST", {}, 200))!;
}

export async function removeHost(fetchFn: FetchFn, id: string): Promise<void> {
  await send(fetchFn, `/api/hosts/${encodeURIComponent(id)}`, "DELETE", {}, 204);
}

export function envText(creds: HostCredentials): string {
  return JSON.stringify({ env: creds.env }, null, 2);
}

export async function copyEnv(
  creds: HostCredentials,
  write: ((text: string) => Promise<void>) | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!write) return { ok: false, error: "Clipboard is not available in this browser." };
  try {
    await write(envText(creds));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function lastSeenText(host: Host, now: number): string {
  return host.lastSeenMs === null ? "waiting for data" : `last seen ${fmtMs(Math.max(0, now - host.lastSeenMs))} ago`;
}
