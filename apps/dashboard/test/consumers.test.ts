// Runs the actual request consumers from App.svelte and Live.svelte, extracted from source, against
// deferred responses. The races here sit between a guarded response and the caller's state write,
// so they have to be tested on the component code, not only on hosts.ts.
import { describe, expect, test } from "bun:test";
import * as helpers from "../src/hosts";
import { LOCAL_HOST, type Host } from "../src/hosts";

const transpiler = new Bun.Transpiler({ loader: "ts" });
const appSource = await Bun.file(`${import.meta.dir}/../src/App.svelte`).text();
const liveSource = await Bun.file(`${import.meta.dir}/../src/Live.svelte`).text();

function extractFunction(source: string, name: string): string {
  const match = source.match(new RegExp(`\\n  (?:async )?function ${name}\\([\\s\\S]*?\\n  }\\n`));
  if (!match) throw new Error(`Could not extract function ${name} from component source`);
  return match[0];
}

function extractOnPop(source: string): string {
  const match = source.match(/\n    const onPop = \(\) => \{[\s\S]*?\n    };/);
  if (!match) throw new Error("Could not extract onPop handler from App.svelte");
  return match[0];
}

type Call = {
  url: string;
  // Settles the response body; headers were already delivered.
  body: (value: unknown) => void;
  status: number;
};

// fetch delivers headers at once and holds the body until the test releases it.
function fakeFetch(statusFor: (url: string) => number = () => 200) {
  const calls: Call[] = [];
  const fetch = (url: string) => {
    let body!: (value: unknown) => void;
    const bodyPromise = new Promise((resolve) => (body = resolve));
    const status = statusFor(String(url));
    calls.push({ url: String(url), body, status });
    return Promise.resolve({ ok: status >= 200 && status < 300, status, statusText: "", json: () => bodyPromise });
  };
  const find = (pred: (url: string) => boolean) => {
    const found = calls.filter((c) => pred(c.url));
    if (!found.length) throw new Error(`no matching call among ${calls.map((c) => c.url).join(", ")}`);
    return found;
  };
  return { fetch, calls, find };
}

// Releases a body, then runs `action` after `gap` microtasks. Somewhere in that range it lands
// after the guard inside the gate has looked at the response but before the component code resumes.
async function interleave(release: () => void, action: () => void, gap: number) {
  release();
  let p = Promise.resolve();
  for (let i = 0; i < gap; i++) p = p.then(() => {});
  p.then(action);
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

// Every race test runs once per gap so it does not depend on how many awaits a path has.
const GAPS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const eachGap = (name: string, fn: (gap: number) => Promise<void>) => test.each(GAPS)(`${name} (gap %i)`, fn);

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const remoteA: Host = { id: "remote-A", name: "A", createdMs: 1, lastSeenMs: null };
const remoteB: Host = { id: "remote-B", name: "B", createdMs: 2, lastSeenMs: null };

function app(opts: { hostId: string; hosts: Host[]; search?: string; hash?: string; statusFor?: (url: string) => number }) {
  const net = fakeFetch(opts.statusFor);
  const historyEdits: { kind: "push" | "replace"; url: string }[] = [];
  const location = { pathname: "/", search: opts.search ?? (opts.hostId === "local" ? "" : `?host=${opts.hostId}`), hash: opts.hash ?? "" };
  const window = {
    history: {
      pushState: (_s: unknown, _t: string, url: string) => {
        historyEdits.push({ kind: "push", url });
        location.search = new URL(url, "http://x").search;
      },
      replaceState: (_s: unknown, _t: string, url: string) => {
        historyEdits.push({ kind: "replace", url });
        location.search = new URL(url, "http://x").search;
      },
    },
  };
  const fns = ["selectHost", "refreshHosts", "load", "loadTurn"].map((n) => extractFunction(appSource, n)).join("\n");
  const code = transpiler.transformSync(`${fns}\n${extractOnPop(appSource)}`);
  const make = new Function(
    "helpers",
    "env",
    `
    const { RequestGate, LOCAL_HOST_ID, LOCAL_HOST, apiUrl, hostFromSearch, reconcileSelection, searchWithHost } = helpers;
    const { fetch, location, window } = env;
    const clock = (t) => "t" + t;
    const minutes = 60;
    let hostId = env.hostId, hosts = env.hosts, hostsLoaded = true, hostsError = null;
    let summary = null, turn = null, selectedPromptId = null, loadError = null, loadErrorStatus = null, updatedText = "";
    const gate = new RequestGate();
    const hostsGate = new RequestGate();
    ${code}
    return {
      selectHost, refreshHosts, load, loadTurn, onPop,
      state: () => ({ hostId, hosts, summary, turn, loadError, updatedText }),
    };
    `,
  );
  const api = make(helpers, { fetch: net.fetch, location, window, hostId: opts.hostId, hosts: opts.hosts });
  return { ...api, net, location, historyEdits };
}

function live(hostId: string) {
  const net = fakeFetch();
  const fns = ["backlog", "resetForHost"].map((n) => extractFunction(liveSource, n)).join("\n");
  const code = transpiler.transformSync(fns);
  const make = new Function(
    "helpers",
    "env",
    `
    const { RequestGate, RunningHooks, apiUrl } = helpers;
    const { fetch } = env;
    let hostId = env.hostId;
    let feed = [], lastSeen = 0, agoText = "", runningList = [], socketOpen = true, nextId = 0;
    const wrap = (e, fresh) => ({ ...e, _id: nextId++, fresh });
    const running = new RunningHooks(120000);
    const gate = new RequestGate();
    ${code}
    return {
      backlog,
      // What the component's host effect does when the hostId prop changes.
      switchTo(id) { hostId = id; resetForHost(); },
      state: () => ({ feed: feed.map((r) => r.label), lastSeen }),
    };
    `,
  );
  return { ...make(helpers, { fetch: net.fetch, hostId }), net };
}

const isSummary = (host: string) => (u: string) => u.startsWith("/api/summary") && u.endsWith(`host=${host}`);
const isList = (u: string) => u === "/api/hosts";

describe("App summary vs host list (host deleted elsewhere)", () => {
  test("control: summary body first, then list drops the host", async () => {
    const a = app({ hostId: remoteA.id, hosts: [LOCAL_HOST, remoteA] });
    a.load();
    a.refreshHosts();
    await flush();
    a.net.find(isSummary(remoteA.id))[0]!.body({ eventCount: 0, generatedAt: 1, marker: "REMOTE_A" });
    await flush();
    a.net.find(isList)[0]!.body([LOCAL_HOST]);
    await flush();
    expect(a.state().hostId).toBe("local");
    expect(a.state().summary).toBeNull();
  });

  test("list body first: the old host's summary must not land under This Mac", async () => {
    const a = app({ hostId: remoteA.id, hosts: [LOCAL_HOST, remoteA] });
    a.load();
    a.refreshHosts();
    await flush();
    const summaryCall = a.net.find(isSummary(remoteA.id))[0]!;
    a.net.find(isList)[0]!.body([LOCAL_HOST]);
    summaryCall.body({ eventCount: 0, generatedAt: 123, marker: "REMOTE_A" });
    await flush();
    expect(a.state().hostId).toBe("local");
    expect(a.state().summary).toBeNull();
    expect(a.state().updatedText).toBe("");
  });

  eachGap("an old host's late failure does not set an error on the new host", async (gap) => {
    const a = app({ hostId: remoteA.id, hosts: [LOCAL_HOST, remoteA], statusFor: (u) => (isSummary(remoteA.id)(u) ? 500 : 200) });
    a.load();
    await flush();
    const failing = a.net.find(isSummary(remoteA.id))[0]!;
    await interleave(
      () => failing.body({ error: "boom from A" }),
      () => a.selectHost(remoteB.id),
      gap,
    );
    expect(a.state().hostId).toBe(remoteB.id);
    expect(a.state().loadError).toBeNull();
  });
});

describe("App turn and A-B-A", () => {
  eachGap("an old host's turn does not land after a switch", async (gap) => {
    const a = app({ hostId: remoteA.id, hosts: [LOCAL_HOST, remoteA, remoteB] });
    a.loadTurn();
    await flush();
    const turnCall = a.net.find((u: string) => u.startsWith("/api/turn") && u.endsWith(`host=${remoteA.id}`))[0]!;
    await interleave(
      () => turnCall.body({ promptId: "p-A", marker: "REMOTE_A" }),
      () => a.selectHost(remoteB.id),
      gap,
    );
    expect(a.state().turn).toBeNull();
  });

  eachGap("A to B to A: the first A request stays stale even though the host id matches again", async (gap) => {
    const a = app({ hostId: remoteA.id, hosts: [LOCAL_HOST, remoteA, remoteB] });
    a.load();
    await flush();
    const firstA = a.net.find(isSummary(remoteA.id))[0]!;
    await interleave(
      () => firstA.body({ eventCount: 0, generatedAt: 1, marker: "OLD_A" }),
      () => {
        a.selectHost(remoteB.id);
        a.selectHost(remoteA.id);
      },
      gap,
    );
    expect(a.state().hostId).toBe(remoteA.id);
    expect(a.state().summary).toBeNull();
    const secondA = a.net.find(isSummary(remoteA.id))[1]!;
    secondA.body({ eventCount: 0, generatedAt: 2, marker: "NEW_A" });
    await flush();
    expect((a.state().summary as { marker: string }).marker).toBe("NEW_A");
  });
});

describe("App host list", () => {
  eachGap("an older list does not overwrite after a newer refresh started", async (gap) => {
    const a = app({ hostId: "local", hosts: [LOCAL_HOST] });
    a.refreshHosts();
    await flush();
    const first = a.net.find(isList)[0]!;
    // The old list may commit if it finished before the newer refresh began, never after.
    let atRefresh: Host[] | null = null;
    await interleave(
      () => first.body([LOCAL_HOST, { ...remoteA, name: "OLD LIST" }]),
      () => {
        atRefresh = a.state().hosts;
        a.refreshHosts();
      },
      gap,
    );
    expect(a.state().hosts).toBe(atRefresh!);
    a.net.find(isList)[1]!.body([LOCAL_HOST, remoteB]);
    await flush();
    expect(a.state().hosts).toEqual([LOCAL_HOST, remoteB]);
  });

  test("a failed list keeps the selection", async () => {
    const a = app({ hostId: remoteA.id, hosts: [LOCAL_HOST, remoteA], statusFor: (u) => (isList(u) ? 503 : 200) });
    a.refreshHosts();
    await flush();
    a.net.find(isList)[0]!.body({ error: "busy" });
    await flush();
    expect(a.state().hostId).toBe(remoteA.id);
  });
});

describe("App history", () => {
  test("control: Back to a removed host from another host normalizes the URL", () => {
    const a = app({ hostId: remoteB.id, hosts: [LOCAL_HOST], search: "?x=keep&host=deleted", hash: "#anchor" });
    a.onPop();
    expect(a.state().hostId).toBe("local");
    expect(a.historyEdits).toEqual([{ kind: "replace", url: "/?x=keep#anchor" }]);
  });

  test("Back to a removed host while already on This Mac still normalizes the URL", () => {
    const a = app({ hostId: "local", hosts: [LOCAL_HOST], search: "?x=keep&host=deleted", hash: "#anchor" });
    a.onPop();
    expect(a.state().hostId).toBe("local");
    expect(a.historyEdits).toEqual([{ kind: "replace", url: "/?x=keep#anchor" }]);
  });

  test("Back to a valid host adds no history entry", () => {
    const a = app({ hostId: "local", hosts: [LOCAL_HOST, remoteA], search: `?x=keep&host=${remoteA.id}` });
    a.onPop();
    expect(a.state().hostId).toBe(remoteA.id);
    expect(a.historyEdits).toEqual([]);
  });
});

describe("Live backlog", () => {
  test("control: a current backlog fills the feed", async () => {
    const l = live(remoteA.id);
    l.backlog();
    await flush();
    l.net.find((u: string) => u.endsWith(`host=${remoteA.id}`))[0]!.body([{ label: "a1", tsMs: 5 }]);
    await flush();
    expect(l.state()).toEqual({ feed: ["a1"], lastSeen: 5 });
  });

  eachGap("an old host's backlog does not refill the feed after a switch", async (gap) => {
    const l = live(remoteA.id);
    l.backlog();
    await flush();
    const old = l.net.find((u: string) => u.endsWith(`host=${remoteA.id}`))[0]!;
    await interleave(
      () => old.body([{ label: "from-A", tsMs: 9 }]),
      () => l.switchTo(remoteB.id),
      gap,
    );
    expect(l.state()).toEqual({ feed: [], lastSeen: 0 });
  });
});
