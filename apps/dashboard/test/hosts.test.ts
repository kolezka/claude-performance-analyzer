import { describe, expect, test } from "bun:test";
import type { LiveEvent } from "@cpa/analytics";
import {
  LOCAL_HOST,
  RequestGate,
  RunningHooks,
  apiUrl,
  copyEnv,
  createHost,
  envText,
  hostFromSearch,
  lastSeenText,
  liveForHost,
  reconcileSelection,
  regenerateHostToken,
  removeHost,
  searchWithHost,
  type Host,
  type HostCredentials,
  type Result,
} from "../src/hosts";

type FetchFn = typeof fetch;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// A fetch whose responses are released by the test, in any order. Honors abort signals like the real one.
function controlledFetch() {
  const calls: { url: string; init?: RequestInit; respond: (r: Response) => void; fail: (e: unknown) => void }[] = [];
  const fn = ((url: string, init?: RequestInit) => {
    const d = deferred<Response>();
    init?.signal?.addEventListener("abort", () => d.reject(new DOMException("aborted", "AbortError")));
    calls.push({ url: String(url), init, respond: d.resolve, fail: d.reject });
    return d.promise;
  }) as unknown as FetchFn;
  return { fn, calls };
}

// Turns RequestGate.run's callbacks back into a value for assertions: null means nothing was committed.
async function collect<T>(gate: RequestGate, fn: FetchFn, url: string) {
  let out = null as Result<T> | null;
  const committed = await gate.run<T>(fn, url, {
    ok: (value) => (out = { ok: true, value }),
    fail: (error, status) => (out = { ok: false, status, error }),
  });
  expect(committed).toBe(out !== null);
  return out;
}

const remote: Host = { id: "h-1", name: "linux box", createdMs: 1000, lastSeenMs: null };
const creds: HostCredentials = {
  host: remote,
  token: "cpa_secret",
  env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://100.64.0.1:4318", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer cpa_secret" },
  tailscaleAddress: "100.64.0.1",
};

describe("host in the URL", () => {
  test("missing or empty host param means local", () => {
    expect(hostFromSearch("")).toBe("local");
    expect(hostFromSearch("?minutes=5")).toBe("local");
    expect(hostFromSearch("?host=")).toBe("local");
  });

  test("reads the host param", () => {
    expect(hostFromSearch("?a=1&host=h-1")).toBe("h-1");
  });

  test("setting a host keeps other query parameters", () => {
    expect(searchWithHost("?a=1&b=two", "h-1")).toBe("?a=1&b=two&host=h-1");
    expect(searchWithHost("?a=1&host=old&b=2", "h-2")).toBe("?a=1&host=h-2&b=2");
  });

  test("selecting local drops only the host param", () => {
    expect(searchWithHost("?a=1&host=h-1&b=2", "local")).toBe("?a=1&b=2");
    expect(searchWithHost("?host=h-1", "local")).toBe("");
  });

  test("api urls always carry the encoded host and keep their own params", () => {
    expect(apiUrl("/api/summary", "h 1", { minutes: 60 })).toBe("/api/summary?minutes=60&host=h+1");
    expect(apiUrl("/api/turn", "local", { prompt: undefined })).toBe("/api/turn?host=local");
  });
});

describe("selection against the host list", () => {
  test("a selection that is still listed survives a reload", () => {
    expect(reconcileSelection("h-1", [LOCAL_HOST, remote])).toBe("h-1");
  });

  test("a host that disappeared from a successful list resets to local", () => {
    expect(reconcileSelection("h-1", [LOCAL_HOST])).toBe("local");
  });

  test("a failed list fetch keeps the selection", () => {
    expect(reconcileSelection("h-1", null)).toBe("h-1");
  });
});

describe("RequestGate", () => {
  test("delivers a current success", async () => {
    const f = controlledFetch();
    const gate = new RequestGate();
    const p = collect<{ n: number }>(gate, f.fn, "/api/summary?host=local");
    f.calls[0]!.respond(Response.json({ n: 1 }));
    expect(await p).toEqual({ ok: true, value: { n: 1 } });
  });

  test("an old host's late success is dropped and its request aborted", async () => {
    const f = controlledFetch();
    const gate = new RequestGate();
    const old = collect(gate, f.fn, "/api/summary?host=h-1");
    gate.invalidate();
    expect(f.calls[0]!.init?.signal?.aborted).toBe(true);
    f.calls[0]!.respond(Response.json({ n: 1 }));
    expect(await old).toBeNull();
  });

  test("an old host's late HTTP failure is dropped", async () => {
    const f = controlledFetch();
    const gate = new RequestGate();
    const old = collect(gate, f.fn, "/api/turn?host=h-1");
    const fresh = gate.invalidate();
    const now = collect<{ n: number }>(gate, f.fn, "/api/turn?host=local");
    f.calls[1]!.respond(Response.json({ n: 2 }));
    expect(await now).toEqual({ ok: true, value: { n: 2 } });
    f.calls[0]!.respond(Response.json({ error: "unknown host" }, { status: 404 }));
    expect(await old).toBeNull();
    expect(fresh).toBe(gate.generation);
  });

  test("a network failure that lands after a switch is dropped", async () => {
    const f = controlledFetch();
    const gate = new RequestGate();
    // Fetch ignores the abort here, like a response already in flight.
    const fn = ((url: string) => {
      f.calls.push({ url, respond: () => {}, fail: () => {} });
      return Promise.reject(new TypeError("network down"));
    }) as unknown as FetchFn;
    const p = collect(gate, fn, "/api/live?host=h-1");
    gate.invalidate();
    expect(await p).toBeNull();
  });

  test("the generation is checked after decoding, not only after headers", async () => {
    const gate = new RequestGate();
    const body = deferred<unknown>();
    const fn = (async () => ({ ok: true, status: 200, statusText: "OK", json: () => body.promise }) as unknown as Response) as unknown as FetchFn;
    const p = collect(gate, fn, "/api/live?host=h-1");
    await Bun.sleep(0);
    gate.invalidate();
    body.resolve([{ label: "old" }]);
    expect(await p).toBeNull();
  });

  test("a decode failure after a switch is dropped too", async () => {
    const gate = new RequestGate();
    const body = deferred<unknown>();
    const fn = (async () => ({ ok: true, status: 200, statusText: "OK", json: () => body.promise }) as unknown as Response) as unknown as FetchFn;
    const p = collect(gate, fn, "/api/summary?host=h-1");
    await Bun.sleep(0);
    gate.invalidate();
    body.reject(new SyntaxError("bad json"));
    expect(await p).toBeNull();
  });

  test("HTTP status is validated before decoding typed data", async () => {
    const gate = new RequestGate();
    let decoded = false;
    const fn = (async () =>
      ({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: async () => {
          decoded = true;
          return { error: "unknown host" };
        },
      }) as unknown as Response) as unknown as FetchFn;
    const r = await collect(gate, fn, "/api/summary?host=gone");
    expect(r).toEqual({ ok: false, status: 404, error: "unknown host" });
    // The body is read only for its error message, never returned as data.
    expect(decoded).toBe(true);
  });

  test("a current failure is reported", async () => {
    const f = controlledFetch();
    const gate = new RequestGate();
    const p = collect(gate, f.fn, "/api/summary?host=local");
    f.calls[0]!.fail(new TypeError("Failed to fetch"));
    expect(await p).toEqual({ ok: false, status: null, error: "TypeError: Failed to fetch" });
  });

  test("invalidate cancels a queued refresh", async () => {
    const gate = new RequestGate();
    let ran = 0;
    gate.soon(() => ran++, 5);
    gate.soon(() => ran++, 5);
    gate.invalidate();
    await Bun.sleep(20);
    expect(ran).toBe(0);
    gate.soon(() => ran++, 5);
    await Bun.sleep(20);
    expect(ran).toBe(1);
  });
});

describe("live feed host filter", () => {
  const ev = (label: string, kind: LiveEvent["kind"] = "tool"): LiveEvent => ({
    id: 1,
    tsMs: 10,
    kind,
    label,
    ms: 5,
    ok: true,
    sessionId: "s",
  });

  test("keeps messages for the selected host", () => {
    const msg = JSON.stringify({ type: "events", host: "h-1", events: [ev("a")], changed: 1 });
    expect(liveForHost(msg, "h-1")).toEqual({ events: [ev("a")], changed: 1 });
  });

  test("drops messages for other hosts and other types", () => {
    expect(liveForHost(JSON.stringify({ type: "events", host: "local", events: [ev("a")], changed: 1 }), "h-1")).toBeNull();
    expect(liveForHost(JSON.stringify({ type: "ping", host: "h-1" }), "h-1")).toBeNull();
    expect(liveForHost("not json", "h-1")).toBeNull();
  });

  test("running hooks are cleared on host switch and pruned when stale", () => {
    const hooks = new RunningHooks(1000);
    hooks.track([{ ...ev("Stop", "hook_start"), tsMs: 100 }]);
    expect(hooks.entries(200)).toEqual([["s|Stop", 100]]);
    hooks.clear();
    expect(hooks.entries(200)).toEqual([]);
    hooks.track([{ ...ev("Stop", "hook_start"), tsMs: 100 }]);
    hooks.track([{ ...ev("Pre", "hook_start"), tsMs: 150 }, { ...ev("Pre", "hook"), tsMs: 160 }]);
    expect(hooks.entries(1050)).toEqual([["s|Stop", 100]]);
    expect(hooks.entries(1200)).toEqual([]);
  });
});

describe("host management requests", () => {
  function recordingFetch(response: () => Response) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fn = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return response();
    }) as unknown as FetchFn;
    return { fn, calls };
  }

  test("create posts JSON and returns credentials", async () => {
    const f = recordingFetch(() => Response.json(creds, { status: 201 }));
    expect(await createHost(f.fn, "linux box")).toEqual(creds);
    const { url, init } = f.calls[0]!;
    expect(url).toBe("/api/hosts");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "linux box" });
  });

  test("create surfaces the server error message", async () => {
    const f = recordingFetch(() => Response.json({ error: "name already used" }, { status: 409 }));
    await expect(createHost(f.fn, "dup")).rejects.toThrow("name already used");
  });

  test("regenerate posts an empty JSON object to the encoded token route", async () => {
    const f = recordingFetch(() => Response.json(creds));
    expect(await regenerateHostToken(f.fn, "h/1")).toEqual(creds);
    expect(f.calls[0]!.url).toBe("/api/hosts/h%2F1/token");
    expect(f.calls[0]!.init?.method).toBe("POST");
    expect(f.calls[0]!.init?.body).toBe("{}");
  });

  test("remove sends DELETE with JSON and accepts 204", async () => {
    const f = recordingFetch(() => new Response(null, { status: 204 }));
    await removeHost(f.fn, "h-1");
    expect(f.calls[0]!.url).toBe("/api/hosts/h-1");
    expect(f.calls[0]!.init?.method).toBe("DELETE");
    expect(new Headers(f.calls[0]!.init?.headers).get("content-type")).toBe("application/json");
  });

  test("remove of an unknown host fails loudly", async () => {
    const f = recordingFetch(() => Response.json({ error: "not found" }, { status: 404 }));
    await expect(removeHost(f.fn, "gone")).rejects.toThrow("not found");
  });
});

describe("reveal", () => {
  test("env text is the pretty env wrapper", () => {
    expect(envText(creds)).toBe(JSON.stringify({ env: creds.env }, null, 2));
  });

  test("copy writes the env block", async () => {
    let written = "";
    const r = await copyEnv(creds, async (t) => {
      written = t;
    });
    expect(r).toEqual({ ok: true });
    expect(written).toBe(envText(creds));
  });

  test("copy failure returns the error instead of throwing", async () => {
    const r = await copyEnv(creds, async () => {
      throw new Error("denied");
    });
    expect(r).toEqual({ ok: false, error: "denied" });
    expect(await copyEnv(creds, undefined)).toEqual({ ok: false, error: "Clipboard is not available in this browser." });
  });

  test("last seen text", () => {
    expect(lastSeenText(remote, 5000)).toBe("waiting for data");
    expect(lastSeenText({ ...remote, lastSeenMs: 2000 }, 5000)).toBe("last seen 3.0s ago");
  });
});
