# Remote Hosts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Use the requested native Agent Teams execution, with isolated Opus implementers and lead integration. Steps use checkbox syntax for tracking.

**Goal:** Receive authenticated telemetry from remote Linux and macOS machines over Tailscale and select one host throughout both local clients.

**Architecture:** Keep one collector and SQLite database, partitioned by authenticated host identity. A peer-address gate precedes every public request; an internal loopback HTML server preserves Bun's HTML bundling without exposing static routes around that gate. Clients share the HTTP contract below, not implementation files.

**Tech Stack:** Bun, bun:sqlite, TypeScript, Svelte, SwiftUI, URLSession, existing Bun HTML compilation.

**Spec:** `docs/superpowers/specs/2026-10-21-remote-hosts-design.md`.

## Global Constraints

- "This Mac" stays the default host. Local id is `local`, with no hosts-table row or token.
- Nothing of ours runs on the remote machine. The user pastes an `env` block into Claude Code settings.
- No combined-host view, remote reads, remote settings writes, HTTPS, or unauthenticated LAN ingest.
- No remote hosts: bind `127.0.0.1` exactly; no wildcard listener or firewall prompt.
- Tokens use `cpa_` plus at least 32 cryptographically random bytes encoded as base64url. Store SHA-256 hashes only; compare hashes in constant time.
- Remote ingest requires both a Tailscale peer (`100.64.0.0/10` or `fd7a:115c:a1e0::/48`) and a valid token. Never trust forwarding headers.
- Non-ingest routes, including HTML, assets, setup, host management and WebSocket upgrade, require a loopback peer plus the existing Host/Origin protections.
- Every telemetry table gains `host_id TEXT NOT NULL DEFAULT 'local'`; existing rows and local behavior remain intact. Retention stays 14 days.
- Remote telemetry must not trigger local repo/config enrichment or local-home expansion. Database access and serving application assets are not the prohibited enrichment reads.
- Bun for collector and tests, SwiftUI for the app. No new runtime dependency is needed.
- Real Claude Code header validation for all three signals and both `http/json` and `http/protobuf` is a release gate, not an assumption or synthetic-test substitute.
- Do not touch real telemetry databases, installed apps, launch agents, settings, or collectors during development checks.

## Review Focus

1. Rotation/removal while an OTLP body is still arriving must not accept stale authority or recreate deleted-host rows. Task 3 tests the actual delayed-body request path.
2. Identical session/prompt ids and matching filesystem paths on different hosts must not share queries, memo entries, repo attribution or hook commands. Tasks 2 and 4 use deliberate collisions.
3. A tailnet client spoofing localhost Host/Origin must not get HTML, generated JS/CSS, an API response or a WebSocket. Task 3 tests the complete dispatcher and actual served assets.
4. A slow old-host response, deletion in the other client, or collector URL change must not show old numbers under a new host label. Tasks 5 and 6 test delayed success and delayed failure.
5. First-host/last-host binding changes must preserve their response and recover honestly from bind failure. Task 3 tests the listener transition and its rollback path.

## Ownership and ordering

| Owner | Exclusive files | Tasks | Dependencies |
| --- | --- | --- | --- |
| Collector Opus | `apps/collector/**`, `packages/analytics/**`, `packages/claude-settings/**`, `README.md` | 1, 2, 3, 4 | Task 3 consumes Task 1 |
| Dashboard Opus | `apps/dashboard/**` | 5 | Frozen HTTP contract; integrate against Task 3 |
| Menubar Opus | `apps/menubar/**` | 6 | Frozen HTTP contract; integrate against Tasks 3 and 4 |
| Lead | Integration and verification; plan checkboxes | 7 | All implementation tasks |

Each of the three implementers works in their own worktree, not this planning worktree or another worker's checkout. Collector, dashboard and menubar may start together; collector executes Tasks 1 through 4 sequentially. Do not edit another owner's files to make a temporary stub compile. Notify the lead of a contract change before using it. Integrate collector/helper, then clients. The implementation is being published to draft PR #29. Suggested commit subjects below describe task boundaries, not a requirement for one commit per task.

## Frozen interfaces

### HTTP and client payloads

```ts
type Host = { id: string; name: string; createdMs: number | null; lastSeenMs: number | null };
type HostCredentials = {
  host: Host;
  token: string;
  env: Record<string, string>;
  tailscaleAddress: string | null;
};
```

- `GET /api/hosts` returns `Host[]`, local first: `{id:"local",name:"This Mac",createdMs:null,lastSeenMs:null}`. Remote hosts follow creation order. Never return token hashes.
- `POST /api/hosts`, JSON `{name}`, returns `201 HostCredentials`. Trim names, require 1 to 80 characters, reject control characters. Invalid input is 400; duplicate exact name or reserved `This Mac` is 409. Generate opaque ids with `crypto.randomUUID()`.
- `POST /api/hosts/:id/token`, JSON `{}`, returns `200 HostCredentials`. `DELETE /api/hosts/:id`, JSON `{}`, returns 204. Unknown id and attempts to mutate `local` return 404. Errors use `{error:string}` without tokens or hashes.
- All management writes require JSON content type and a same-origin Origin, including native-client writes. Swift supplies the collector origin explicitly; the OS supplies the Host header.
- `GET /api/summary`, `/api/status`, `/api/live`, `/api/turn`, `/api/turns`, `/api/event`, `/api/item` accept `host`, default `local`. Unknown host returns 404 before querying. Existing response shapes stay unchanged.
- WebSocket `/ws` stays a local read channel. Events are `{type:"events",host:string,events:LiveEvent[],changed:number}`. Clients ignore nonselected hosts. Do not introduce a combined view.
- `HostCredentials.env` is a flat env map. Both clients copy `JSON.stringify({env}, null, 2)` or the Swift equivalent. Tokens/env exist only in the current reveal view, never preferences, URL, logs, or a refetchable credential endpoint.
- Find the first IPv4 Tailscale address in `networkInterfaces()` when creating each credentials response. Endpoint is `http://<address>:<port>`. If absent, use literal `http://<THIS_MAC_TAILSCALE_IP>:<port>`, return `tailscaleAddress:null`, and show a replacement warning.
- Helper: `telemetryEnv(endpoint: number | string, headers?: string): Record<string,string>`. Numeric ports preserve existing local callers; a string is the complete endpoint. Include `OTEL_EXPORTER_OTLP_HEADERS` only when supplied. Remote header value is exactly `Authorization=Bearer <token>`.

### Collector host context

```ts
interface HostContext { id: string; home: string | null; mayReadDisk: boolean }
// hostContext("local") uses homedir(); every remote context uses home:null, mayReadDisk:false.
```

Keep remote paths verbatim rather than guessing a home directory. Extend `extractPaths(attrs, home: string | null)` so null preserves `~`/`~/...` and absolute paths without expanding against this Mac. Local string-home behavior stays unchanged.

Store methods keep their existing arguments and add a final `hostId = "local"`: `addEvents`, `addSpans`, `addMetrics`, `events`, `eventsByName`, `hookEventsByLabel`, `promptEvents`, `event`, `sessionEvents`, `sessionEventsByNames`, `eventsByNameForSessions`, `spans`, `spansForSession`. Production request handlers always pass the resolved id explicitly. Keep parser row types unchanged; persistence identity comes from auth, never payload attributes. `prune` remains intentionally global.

Remote hook definitions keep the existing `source` values `plugin`, `user`, `project` and add optional `hookEvent` and `hookSource` fields carrying the registered telemetry values. `command` and `configPath` are null; `type` is `telemetry`; summary says `Registered on remote host`. Retain plugin, matcher and session count. Local definition payloads remain compatible.

## Verified starting points and listener decision

Source inspected at planning HEAD `64cca56b5281b786ce650757eb86e36a72ca0e77`:

- `apps/collector/src/index.ts` owns startup, routes, session cache, enrichment and broadcasting. `db.ts` has positional INSERTs that must become explicit-column INSERTs before adding host columns.
- Repo lookup occurs in both `index.ts:repoForEvent` and `sessions.ts:buildSessionInfo`. Hook configuration reads occur in `hooks.ts:buildHookDefinitions`. Guarding just one entry point is insufficient.
- Dashboard files are in `apps/dashboard`, not `apps/web` or `packages/dashboard`. It currently fetches summary, turn and live, plus setup.
- Swift uses polling for live data, not WebSockets. Keep that design. Detail views have their own asynchronous loads and identities independent of the polling tasks.
- `apps/menubar/scripts/build.sh` compiles source with `swiftc`, bundles the collector, and signs only the worktree build. Add a small executable Swift test harness rather than switching build systems.

Disposable Bun 1.4.2/macOS arm64 probes returned these decoded markers: `0.0.0.0` served IPv4 `ipv4-control` but refused IPv6; `::` served both IPv4 and IPv6 `dual-control`. A same-port transition using `old.stop(false)` followed immediately by `Bun.serve` returned the initiating `response-survived` body and replacement `wide-control`. Capture the configured port before stopping: the stopped server's `port` becomes unusable for this purpose.

Choose one public listener: `127.0.0.1` with no remotes, `::` dual-stack with remotes. Do not also bind `0.0.0.0` on the same port. Rebind in process; do not restart launchd or the installed collector. These observations do not prove the packaged binary path; Task 7 rechecks that path.

A separate disposable HTML-import probe confirmed a Bun HTML route returns 200 with `html-control` even when fallback fetch returns 403. A gated proxy to the loopback HTML server returned both that HTML and its actual generated JavaScript containing `asset-control`; denying the gate returned 403 for the generated asset. This is why the public listener must not register direct HTML/static routes.

### Task 1: Endpoint-aware settings helper

**Files:** Modify `packages/claude-settings/src/index.ts`; test `packages/claude-settings/test/settings.test.ts`.

**Interfaces:** Produces `telemetryEnv(endpoint: number | string, headers?: string)` from the frozen contract. Own no collector call sites.

- [ ] **Write failing tests** for numeric-port equality with the existing env block, arbitrary endpoint preservation, exact authorization header inclusion, and omission of the header when absent. Assert `telemetryEnv(4318).OTEL_EXPORTER_OTLP_ENDPOINT === "http://127.0.0.1:4318"` and remote header equality, not only key presence.
- [ ] **Run RED:** `bun test packages/claude-settings/test/settings.test.ts`. Record the new failing assertions separately from any baseline failure.
- [ ] **Implement** the signature without altering `applyEnv`, conflict behavior, existing variables, JSONC preservation or local setup semantics.
- [ ] **Run GREEN:** repeat the scoped test command. Report the commit-ready diff to the lead; suggested commit `feat(settings): support remote telemetry endpoints and headers`.

### Task 2: Host registry, authentication primitives and partitioned storage

**Files:** Modify `apps/collector/src/db.ts`, `apps/collector/test/db.test.ts`; create `apps/collector/src/hosts.ts`, `apps/collector/src/access.ts`, `apps/collector/test/hosts.test.ts`, `apps/collector/test/access.test.ts`, `apps/collector/test/host-storage.test.ts`.

**Interfaces:** `hosts.ts` exports `Host`, `HostCredentials`, `HostContext`, `hostContext(id)`, `createToken(): string`, `hashToken(token): string`. `access.ts` exports `classifyPeer(address: string | null): "loopback" | "tailscale" | "other"` and `authorizeIngest(address, authorization, store): {hostId:string} | Response`. Store adds `hosts(): Host[]`, `host(id): Host | null`, `createHost(name, tokenHash, nowMs): Host`, `rotateHostToken(id, tokenHash): boolean`, `removeHost(id): boolean`, `hostForTokenHash(hash): Host | null`, `touchHost(id, nowMs): void`.

- [ ] **Write failing storage tests** using a legacy database fixture containing all three original tables and known rowids/attrs. Open twice and assert old values/rowids survive, all old rows have host_id `local`, schema changes run once, and host-leading time/prompt/session indexes exist. Insert local and remote rows with identical session/prompt ids and test every listed store reader, including latest-prompt fallback and eventsByNameForSessions. Inspect raw metrics as well as events/spans.
- [ ] **Write failing registry/address tests:** no plaintext token or token in GET projections; duplicate names; local immutability; rotation invalidates old token; deletion atomically removes registry and all three signal tables while retaining other hosts; rollback retains everything. Test v4 range boundaries, expanded/compressed Tailscale v6, `::1`, IPv4-mapped loopback/Tailscale addresses, malformed/null/outside addresses. Forwarded headers are not inputs.
- [ ] **Run RED:** `bun test apps/collector/test/db.test.ts apps/collector/test/host-storage.test.ts apps/collector/test/hosts.test.ts apps/collector/test/access.test.ts`.
- [ ] **Implement storage and registry.** Wrap guarded ALTERs in a transaction, use explicit INSERT column lists, and add host-leading indexes. Keep every SQL predicate host-scoped, including nested latest-prompt selection and rowid lookup. Generate 32 random bytes with `crypto.getRandomValues`; hash SHA-256 and compare fixed-size digest buffers with `timingSafeEqual`. Do not cache valid credentials across rotation/removal. Trim/validate names at the management boundary and enforce uniqueness in SQLite.
- [ ] **Implement peer normalization and auth.** Accept absent authorization only on loopback. If authorization is present but invalid, return 401 even on loopback. Non-Tailscale non-loopback peers get 403 before token lookup. Valid bearer tokens on loopback tag the remote host. Missing requestIP fails closed. Do not rely on a textual prefix for IPv6 membership.
- [ ] **Run GREEN:** repeat the scoped command. Suggested commit `feat(collector): partition telemetry storage by authenticated host`.

### Task 3: Gated HTTP, host management and live rebinding

**Files:** Modify `apps/collector/src/index.ts`, `apps/collector/test/server.ts`, `apps/collector/test/host-check.test.ts`, `apps/collector/test/ingest.test.ts`, `apps/collector/test/setup.test.ts`; create `apps/collector/src/http.ts`, `apps/collector/src/listener.ts`, `apps/collector/test/remote-http.test.ts`, `apps/collector/test/listener.test.ts`.

**Interfaces:** Consume Tasks 1 and 2. `http.ts` exports `createRequestHandler(deps: {store: Store; port: number; dashboard: (req: Request) => Promise<Response>; rebind: (remoteEnabled: boolean) => void; publish: (message: string) => void})`. Its return signature is `(req: Request, server: RequestServer) => Promise<Response | undefined>`, where `RequestServer` is the narrow `requestIP`/`upgrade` portion of the Bun server API. The actual accepting server supplies requestIP; tests supply the same adapter interface. `listener.ts` owns current/draining servers and `rebind(remoteEnabled: boolean): void`. Keep production startup/retention in `index.ts`, not import-time side effects in testable modules.

- [ ] **Write failing request tests** for each signal and both supported encodings: missing/wrong/valid/rotated/deleted token, local no-token acceptance, spoofed payload host attrs, and correct stored host_id. Use a gated request-body stream to rotate/delete after authorization but before body completion; assert 401 and no rows. Revalidate the token immediately before synchronous save, with no await between validation and storage.
- [ ] **Write the route matrix:** nonloopback peer plus localhost Host/Origin gets 403 for root, generated asset URLs, every seven telemetry read endpoint, setup GET/POST, hosts GET/POST, token POST, DELETE, `/ws`, unknown paths, HEAD and non-ingest methods on `/v1/*`. Use the real dispatcher with a controlled requestIP adapter, not only classifier tests. Loopback positive controls must return decoded expected bodies. Keep existing foreign Host/Origin rejection tests.
- [ ] **Write failing management/listener tests:** list local first; create/reveal once; regenerate; duplicate/invalid names; unknown/local mutation; unknown host reads; last_seen after accepted remote ingest and at most once per minute per host. First add and last remove change the socket binding without losing their HTTP response. Inject bind failure and assert operation fails visibly without partial registry/data changes. Cover two consecutive mutations and shutdown with open WebSockets.
- [ ] **Run RED:** `bun test apps/collector/test/remote-http.test.ts apps/collector/test/listener.test.ts apps/collector/test/host-check.test.ts apps/collector/test/ingest.test.ts apps/collector/test/setup.test.ts`.
- [ ] **Implement the public dispatcher** with only the three exact POST ingest paths exempt from the loopback read gate. Retain Host checks for all local reads and same-origin JSON checks for writes. Allow bracketed IPv6 loopback Host/Origin as well as existing IPv4/localhost forms. Dispatch `/ws` after the peer gate. Apply `Cache-Control: no-store` to credentials and management responses; never log Authorization or response secrets.
- [ ] **Preserve HTML bundling behind the gate.** Serve the existing HTML import on a private `127.0.0.1` ephemeral Bun server; the public listener has one fetch dispatcher, not unguarded Bun HTML/static routes. After access checks, proxy permitted HTML/assets to that server while preserving status/body/content type. Do not forward external Host or Authorization. Disable dev HMR as today. Test the HTML's actual generated asset URLs, not guessed paths.
- [ ] **Implement listener transitions** using captured configured port, `stop(false)` without awaiting drain before re-serve, and `::` for dual-stack remote mode. Close retired WebSockets with 1001 so clients reconnect, and publish through the active server. Serialize synchronous host mutation plus transition: on bind failure restore prior binding and roll back the SQLite mutation, return 503. If restoration fails, fail loudly rather than claim success. Never wait for an open WebSocket to drain before binding. Preserve `CC_WAIT_FOR_PORT` startup behavior.
- [ ] **Implement management routes and ingest metadata.** Deletion removes rows and registry in one transaction; successful rotation/removal is effective before the response. Throttle last_seen with host-scoped state or conditional SQL, clear host state on deletion, and broadcast logs with the authenticated `host`. All seven reads resolve/validate host before any query. Setup always configures this Mac, regardless of the current selection.
- [ ] **Run GREEN:** repeat the scoped tests and `bun test apps/collector/test/port-in-use.test.ts`. Suggested commit `feat(collector): gate remote ingest and manage host listeners`.

### Task 4: Host-scoped enrichment with no remote disk access

**Files:** Modify `apps/collector/src/http.ts`, `apps/collector/src/sessions.ts`, `apps/collector/src/hooks.ts`, relevant existing collector enrichment tests, `packages/analytics/src/index.ts`, `packages/analytics/test/paths.test.ts`; create `apps/collector/test/remote-enrichment.test.ts` and `apps/collector/test/host-scoping.test.ts`.

**Interfaces:** `buildSessionInfo(sessionId, events, context: HostContext): SessionInfo | null`; `buildHookDefinitions(itemName, registeredRows, repoRootForSession, context: HostContext): HookDefinition[]`. Add `pathTimeline: {tsMs:number;promptId:string|null;path:string}[]` to collector SessionInfo and `pathAsOf(info, tsMs, promptId): string | null` for remote display. Keep local repo/branch as-of behavior intact. Consume nullable-home extractPaths and frozen remote definition fields.

- [ ] **Write failing tests** with a real temporary local git repo/config and remote telemetry referencing the identical absolute path plus `~/...`. Assert local enrichment resolves its fixture, remote repo is null, remote folder remains the transmitted path, worktree is false, and commands/config paths stay null. Test pluginHook, userSettings and projectSettings registrations, retaining event/matcher/plugin. Add spies or narrow injected enrichment dependencies that throw if called for remote data, with a local positive control proving the spy observes those reads.
- [ ] **Write the seven-endpoint isolation matrix.** Seed local and two remote hosts with colliding session/prompt ids and distinct sentinels/durations. Verify summary, status, live, turn, turns, event and item only contain the selected host's evidence. Prime the session cache in both orders. Event rowids from another host must 404; latest turn, span correlation, hook registration queries and headless filtering must remain host-scoped. Unknown host must 404 on each endpoint.
- [ ] **Run RED:** `bun test apps/collector/test/remote-enrichment.test.ts apps/collector/test/host-scoping.test.ts packages/analytics/test/paths.test.ts`.
- [ ] **Implement context propagation** through session metadata, repoForEvent, recent/failed item rows, turn list/detail and hook definitions. Key session memo by `[hostId, sessionId]`, not sessionId alone. Remote contexts never invoke gitRoot, repoRootForSession, config readers or plugin resolution. Collect raw path timelines from telemetry for remote folder display; use the current event's path first, then session as-of path. Do not invent a repo from a basename. Hook remote output is built from registration rows before any configuration branch.
- [ ] **Run GREEN** with the preceding tests plus `bun test apps/collector/test/folder.test.ts apps/collector/test/folder-as-of.test.ts apps/collector/test/repo-as-of.test.ts apps/collector/test/item-repo.test.ts apps/collector/test/hooks.test.ts apps/collector/test/item-hooks.test.ts apps/collector/test/session-kind.test.ts apps/collector/test/turn-detail.test.ts apps/collector/test/turn-lanes.test.ts`. Suggested commit `feat(collector): isolate remote metadata from local files`.

### Task 5: Dashboard host selection and management

**Files:** Modify `apps/dashboard/src/App.svelte`, `apps/dashboard/src/Live.svelte`, `apps/dashboard/src/style.css`; create `apps/dashboard/src/Hosts.svelte`, `apps/dashboard/src/hosts.ts`, `apps/dashboard/test/hosts.test.ts`. Change `Setup.svelte` only if needed to label it explicitly as this-Mac setup.

**Interfaces:** Consume frozen HTTP payloads. `hosts.ts` defines Host/HostCredentials client types and shared request/selection helpers used by the actual components, not test-only replicas. `Live` takes `hostId: string` and `onData: () => void`. Hosts management notifies App after successful mutations.

- [ ] **Write failing tests** for URL host parsing/updating without dropping other query parameters; valid selection after reload; successful host-list disappearance resets to local; failed list fetch does not erase selection. Use deferred fetch responses to prove old-host summary/turn/backlog successes and failures cannot overwrite newer state. Test WebSocket host filtering and clearing running hooks on host switch.
- [ ] **Run RED:** `bun test apps/dashboard/test/hosts.test.ts`.
- [ ] **Implement selection** in the header, synchronized with `?host=` and browser history navigation. Refresh hosts on mount, after management changes and on the existing 30-second refresh. A host change invalidates requests, clears summary/turn/prompt/live/running-hook/error state, cancels queued refresh timers, then fetches the selected host. Use both aborts and monotonically increasing generations; check generation after decoding, including catch paths. Validate HTTP status before decoding typed data. Empty remote state must not offer local OTLP instructions as remote setup.
- [ ] **Implement Hosts section** next to setup: list with last seen or `waiting for data`, Add, Regenerate, confirmed Remove stating that all saved telemetry is deleted. Reveal `{env}` once with Copy and dismissal; show one-time-token, firewall and missing-Tailscale warnings. Preserve an undismissed reveal on copy failure and display the error. Never persist secrets or insert host names through raw HTML. Keep setup explicitly local.
- [ ] **Run GREEN:** `bun test apps/dashboard/test`. Exercise the rendered Svelte UI against an isolated collector: create, copy, switch, reload, rotate, delete in another client, and observe fallback within one refresh. The lead repeats this in the production build. Suggested commit `feat(dashboard): select and manage telemetry hosts`.

### Task 6: Menubar selection, Hosts settings and stale-request protection

**Files:** Modify `apps/menubar/Sources/Networking/Telemetry.swift`, `Sources/Settings/Prefs.swift`, `Sources/Settings/SettingsView.swift`, `Sources/Views/Panel/PanelView.swift`, `Sources/Views/Panel/TurnSection.swift`, `Sources/Views/MenuBar/MenuBarLabel.swift`, `Sources/App/ClaudeTelemetryApp.swift`, `Sources/Views/Detail/DetailWindowView.swift`, `Sources/Views/Detail/EventDetailView.swift`, `Sources/Views/Detail/ItemDetailView.swift`, `Sources/Views/Detail/TurnDetailView.swift`, `Sources/Models/DetailPayloads.swift` (all beneath `apps/menubar/`). Create `apps/menubar/Sources/Models/HostPayloads.swift`, `apps/menubar/Sources/Settings/HostsSettingsTab.swift`, `apps/menubar/Tests/TelemetryHostsTests.swift`, `apps/menubar/test/hosts.test.ts`.

**Interfaces:** Swift `TelemetryHost: Decodable, Identifiable` and `HostCredentials: Decodable` mirror the frozen payloads. Telemetry exposes `hosts`, `selectedHostId`, `selectedHostName`, `selectionGeneration`, `refreshHosts() async`, `addHost(name:) async throws -> HostCredentials`, `regenerateHostToken(id:) async throws -> HostCredentials`, `removeHost(id:) async throws`. Add `Prefs.Key.selectedHostId` to allManaged. Preserve collectorURL as a distinct setting.

- [ ] **Create failing executable Swift tests** using an injected URLSession with controlled URLProtocol and isolated UserDefaults. Test URLComponents host encoding for every existing telemetry request; management Origin/content type; local first/default; selection persistence; absent-host fallback after successful host list; no fallback on connection error. Delay A's responses until B is selected and assert status, summary, live, turns, selected turn and errors cannot revert. Test collector URL changes with the same host/id values, reset-all behavior, and credentials decoding without persistence.
- [ ] **Wire the Bun test wrapper** to compile the existing Swift Sources except `ClaudeTelemetryApp.swift`, plus the test harness's async `@main`, into a temporary directory using swiftc and the app's frameworks. Execute the binary and assert meaningful named assertions pass. Use `process.platform === "darwin"` for the platform guard, not a fake green substitute. Run RED: `bun test apps/menubar/test/hosts.test.ts` on this Mac.
- [ ] **Implement networking and selection.** Inject session/defaults and optionally suppress automatic polling for tests while preserving `Telemetry()` behavior. Centralize telemetry URL generation with host query items. Refresh host list initially and periodically even when the panel is closed. Capture collector URL, selected host and generation for each request; discard obsolete results/errors. Selection changes cancel all four existing tasks, clear telemetry/turn/error state and navigator stack, increment generation, persist the new id and restart the appropriate polling. A host-list failure must not silently label remote state as local.
- [ ] **Implement UI.** Add header picker and Hosts settings tab with the dashboard's actions/warnings/reveal rules. Show the remote host name next to the menu bar value and in accessibility text while preserving local label behavior and icon-only preference. Open Dashboard with the selected `host` query. Reset-all selects local. Remount detail content by selectionGeneration and include generation in detail task identities/late-result checks, including manually started Refresh tasks. Add `Telemetry.displayPath(_ path: String) -> String`, using `abbreviateHome` only for local selection. Use it in TurnSection, ItemDetailView recent rows and TurnDetailView so a remote path matching this Mac's HOME remains verbatim; test that exact collision. Decode/show remote hook event/source while leaving command/config absent.
- [ ] **Run GREEN:** `bun test apps/menubar/test/hosts.test.ts`. Compile the Swift app in this owner's worktree without opening or installing it; the lead performs the complete bundled build after integration. Manually check picker, label, Hosts tab and an already-open details window against the isolated collector. Suggested commit `feat(menubar): scope telemetry and settings to selected host`.

### Task 7: Integrated verification, real exporter gate and documentation

**Files:** Collector owner updates `README.md`; lead updates this plan's status/checks. If a reusable exporter probe is needed, collector owner creates `apps/collector/scripts/verify-otlp-headers.ts` and its focused tests under `apps/collector/test/`.

**Interfaces:** Final integrated branch must implement the frozen contract. Do not count isolated worker results as final branch verification.

- [ ] **Verify the integrated diff and call sites** for all changed shared signatures, storage readers, get/fetch paths, detail task identities, repo/config reads and host-management writes. Review against the spec with an independent permitted model, including a security pass over the public dispatcher and static assets. Resolve findings in the owning worktree.
- [ ] **Run final checks:** `bun test` and `bun run typecheck` from the integrated worktree, capturing each exit status and any baseline failures distinctly. Run `bun run --filter @cpa/menubar build` only while no other worker is mutating that worktree's build outputs. Inspect the built app/collector, not just source execution. No install, open command or launch-agent mutation is part of this build.
- [ ] **Exercise the packaged collector** on an ephemeral port/temp data directory, with production mode and temporary settings. Check local default, migration fixture, first-add/last-remove responses, IPv4 plus IPv6 reachability while enabled, IPv4-only loopback after removal, dashboard and generated assets, WS reconnect and host-tagged messages. Observe actual requestIP peer values. Use a nonloopback interface with positive control when available; verify spoofed localhost Host/Origin is denied. Synthetic requestIP tests remain necessary for Tailscale boundaries, not a substitute for socket integration.
- [ ] **Run real Claude Code exporter validation** in a disposable config/session against an isolated receiver, not against the user's collector. Record the installed Claude Code version. For each of `http/json` and `http/protobuf`, configure the generated `OTEL_EXPORTER_OTLP_HEADERS`, perform a small real session that emits logs, traces and metrics, allow exporter flush, and decode all three request bodies. For each of the six cells, assert exact Authorization equality in memory and meaningful decoded records attributable to this session. Report only pass/fail and decoded record kinds, never token values or private prompts. Include a known-good synthetic sender to validate the capture instrument. If a signal is absent, the cell is unverified, not passing. If the runtime rejects a protocol or drops headers, stop the release and report that evidence; do not weaken auth.
- [ ] **Check both UI flows together** against the same isolated instance: switching never mixes numbers; a deletion in one client resets the other after host refresh; stale responses cannot resurrect removed data; regenerated credentials work and old credentials fail; missing Tailscale produces a clearly unusable placeholder. Remote Linux/macOS paths remain unchanged and do not inherit local source attribution.
- [ ] **Update README** privacy, setup, topology diagram and collector table entry. Explain default loopback, opt-in wildcard binding with Tailscale/token ingest only, local-only reads, one-time credentials, remote settings env, missing-address placeholder, possible firewall prompt, destructive removal, and lack of remote disk enrichment. Do not claim real exporter compatibility unless the six-cell gate passed. Suggested commit `docs: explain remote host setup and privacy boundaries`.
- [ ] **Report actual outcome** with final test/build status, real exporter matrix, any unverified Linux/macOS end-to-end coverage, review findings and remaining blockers. No fourth implementation attempt after three failed fixes; escalate with falsified hypotheses.

## Self-review and handoff

Coverage checked against spec sections: hosts/tokens (Tasks 2 and 3), ingest/peer checks and listener lifecycle (Task 3), migrations/query scoping (Tasks 2 and 4), API/env (Tasks 1 and 3), no-disk enrichment (Task 4), menu bar (Task 6), dashboard (Task 5), tests/privacy docs/real exporter gate (Task 7). The five Review Focus conditions have owning tests above.

## Pre-merge verification (73684f1)

Tasks 1 through 6 are implemented. Task 7's automated checks and local runtime checks passed; the manual checks listed below remain open, so the PR stays a draft.

- `bun test`: 272 passed, 0 failed across 46 files. The Swift host/lifecycle harness executes 38 named checks against production types. A separate NSHostingView harness verifies header bounds at all supported panel widths, including long host names and both window sets.
- `bun run typecheck`: passed.
- `SIGN_IDENTITY=- bun run --filter @cpa/menubar build`: passed. Both the app and bundled collector contain arm64 and x86_64 slices; ad-hoc signature verification passed. No installation or launch-agent change was performed.
- The collector inside the built app decoded and stored all three Protobuf signals from an empty temporary working directory, preserving marker, session, host, trace-id and numeric values.
- Real Claude Code 2.1.307 sessions using the generated host configuration delivered logs, traces and metrics through both JSON and Protobuf to the compiled collector. Both sessions used `claude-opus-5-5[1m]`. This exercised the Mac's own Tailscale address, not another machine.
- The compiled dashboard was exercised with the real isolated collector: host creation and selection, host-specific data, copy wiring through a test clipboard, rotation, deletion and automatic fallback. Real socket tests rejected spoofed localhost headers from a nonloopback peer.

Review and runtime checks found and fixed the dashboard's late-response/history bugs, the menu bar's late-delete and credential-lifetime bugs, and failed-COMMIT listener recovery. The new compiled-binary test also exposed a pre-existing packaging defect: Protobuf schemas were not embedded. They are now static text imports in `packages/otlp`, covered by `apps/collector/test/compiled-protobuf.test.ts`.

Reproduction commands for the added acceptance checks:

```sh
bun test apps/collector/test/host-storage.test.ts apps/collector/test/remote-http.test.ts
bun test apps/collector/test/host-scoping.test.ts apps/collector/test/remote-enrichment.test.ts
bun test apps/collector/test/compiled-protobuf.test.ts apps/collector/test/commit-fault.test.ts
bun test apps/dashboard/test
bun test apps/menubar/test/hosts.test.ts
```

Process note: the initial HTTP module was written before its acceptance tests. It was removed from the test tree to obtain a failing run, then restored; this was not a strict test-first cycle. Later fixes were checked with failing regressions or isolated negative controls.

Remaining manual checks:

- Full interactive Hosts-tab lifecycle, details-window and manual Refresh behavior. A native preview was opened and exposed horizontal header overflow. The follow-up layout uses a bounded host row and adaptive time controls, with real SwiftUI sizing tests and an original-layout negative control; the corrected preview was launched.
- Actual remote Linux/macOS-to-Mac traffic. The supplied machines currently use different tailnets; no network profile was switched.
- OS clipboard behavior, macOS firewall prompts, notarization and installed launchd behavior. Clipboard wiring was tested with an in-memory substitute, and the app build was ad-hoc signed only.
