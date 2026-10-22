# Remote hosts: design

Date: 2026-10-21. Status: implementation authorized on 2026-10-22.

Implementation plan: [Remote hosts](../plans/2026-10-22-remote-hosts.md).

## Intent

Today ClaudeTelemetry only sees Claude Code running on this Mac. The user also runs Claude Code on other machines (Linux or macOS) that reach this Mac over Tailscale. They want those machines to send telemetry to the collector on this Mac, and to switch between hosts in the menu bar app and the web dashboard to look at each one's numbers.

"This Mac" stays the default host. Someone who never adds a host sees no change.

## Goals

- A remote machine sends OTLP straight to the collector on this Mac. Nothing of ours runs on the remote machine: only Claude Code with an `env` block in its `~/.claude/settings.json`.
- Works the same for a Linux and a macOS remote.
- Add a host: give it a name, get a generated service token and a ready-to-paste `env` block.
- Remove a host: its token stops working at once.
- Switch hosts in both the menu bar panel and the web dashboard. Every view shows one host at a time.
- Every stored row carries the host it came from.

## Non-goals

- A combined "all hosts" view. One host at a time is enough for now.
- Reading the API or dashboard from another machine. Reads stay on this Mac.
- An agent, daemon or app on the remote machine.
- Writing the remote machine's `settings.json` for the user (the existing setup button only touches this Mac).
- HTTPS. Tailscale already encrypts the link.
- Plain LAN access outside Tailscale.

## Anti-goals (would count as failure even if it works)

- Remote data getting labelled with this Mac's repos, plugins or hook sources. Showing nothing is acceptable; showing a wrong source is not.
- Anyone in the tailnet being able to read prompts, paths or repo names.
- The collector quietly accepting remote data with no token, or quietly dropping remote data after a Tailscale IP change.
- Any change in behaviour for a user who never adds a host (still bound to `127.0.0.1`, no macOS firewall prompt).

## Current state (from the code)

- Collector binds `127.0.0.1:4318` (`apps/collector/src/index.ts`, `serve()`). Ingest routes `/v1/logs`, `/v1/traces`, `/v1/metrics` have no auth. Read routes go through `guarded()`, which checks the `Host` header against `127.0.0.1:<port>` / `localhost:<port>`.
- SQLite tables `events`, `spans`, `metrics` in `apps/collector/src/db.ts`, no host column. Retention 14 days.
- OTLP resource attributes are merged into each row's `attrs` (`packages/otlp/src/json.ts`).
- Several things read the Mac's own disk and assume the telemetry came from this Mac:
  - repo resolution: `gitRoot()` in `apps/collector/src/repos.ts`, called from `repoForEvent()` in `index.ts` and from `buildSessionInfo()` in `sessions.ts`;
  - `extractPaths(attrs, HOME)` expands `~` with this Mac's home;
  - hook source attribution: `buildHookDefinitions()` in `apps/collector/src/hooks.ts` reads `settings.json`, `plugin.json` and project `.claude/` files from disk;
  - `folderFor()` shortens paths using this Mac's `HOME`.
- The menu bar app already has a configurable collector URL (`Prefs.Defaults.collectorURLString`, `ConnectionSettingsTab.swift`) and talks to the API through `Telemetry.swift`.
- `telemetryEnv(port)` in `packages/claude-settings` builds the env block with `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port>`.

## Decided with the user

1. Remote machines send to the collector on this Mac. One collector, one database.
2. Transport is Tailscale only.
3. A generated service token, one per host. The token is how the collector knows which host sent the data.
4. The host switch lives in both the menu bar panel and the web dashboard.
5. Remote hosts may be Linux or macOS.

## Design

### Hosts and tokens

New table `hosts`: `id TEXT PRIMARY KEY`, `name TEXT NOT NULL UNIQUE`, `token_hash TEXT NOT NULL`, `created_ms INTEGER NOT NULL`, `last_seen_ms INTEGER`.

- The local host is implicit with id `local`, display name "This Mac". It has no row and no token.
- Token format: `cpa_` plus at least 32 random bytes, base64url. Generated with `crypto.getRandomValues`.
- Only a SHA-256 hash is stored. The full token is shown once, in the response to "add host" and "regenerate token". Comparison is constant-time on the hash.
- Remove host deletes the row and all of that host's rows in `events`, `spans` and `metrics`, in one transaction (user's decision). The UI confirms first and says the data goes too. Clients that had the removed host selected fall back to "This Mac".
- Regenerate token replaces the hash; the old token stops working at once.

### Ingest rules

For every `POST /v1/*`:

- Source address loopback (`127.0.0.1`, `::1`): accepted with no token, tagged `local`. This keeps every existing setup working. If a loopback request does carry a valid token, tag it with that host (useful for testing).
- Any other source address: must be in Tailscale's ranges (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) **and** carry `Authorization: Bearer <token>` matching a host. Otherwise `401` (bad or missing token) or `403` (address outside Tailscale), with nothing stored.
- Source address comes from `server.requestIP(req)`, never from a header.
- On accepted remote ingest, update `last_seen_ms` (throttle the write, for example once per minute per host).

Every route other than `POST /v1/*` (the dashboard page, all `/api/*` including setup and host management, and `/ws`) is this-Mac-only, gated on the **peer address** being loopback (`server.requestIP(req)`). The existing `Host` and `Origin` checks stay as a second layer against DNS rebinding, but they are client-supplied and cannot be the gate: a tailnet client can send `Host: 127.0.0.1:4318`. Test exactly that case: a non-loopback peer with a spoofed localhost `Host` and `Origin` gets `403` on every read route, on `/ws`, and on every host-management and setup write.

The token is the real gate for remote ingest. The Tailscale address range is a second layer, not proof that traffic came over Tailscale (my call: with a token required, interface-level enforcement is not worth the complexity).

### Listening address

- No remote hosts: bind `127.0.0.1` exactly as today.
- At least one remote host: bind `0.0.0.0` (and `::` if Bun needs a separate socket for IPv6), with the address filter above doing the gating. Binding the wildcard instead of the Tailscale IP means a changed Tailscale IP never silently stops ingest.
- Adding the first host or removing the last one must change the binding without the user restarting anything. How (stop and re-serve in-process, or have the app's launch agent restart the collector) is the builder's call.
- Binding the wildcard address may trigger the macOS firewall prompt once. Say so in the add-host UI.

### Storage

- Add `host_id TEXT NOT NULL DEFAULT 'local'` to `events`, `spans`, `metrics` through `ALTER TABLE` on open, guarded so it runs once. Existing rows become `local`.
- Add `host_id` as the leading column of the existing time and session indexes (or add new ones), so per-host queries stay as fast as today's.
- Every store query that feeds an API response takes a host id. Session ids are UUIDs, but filter by host anyway so one host's data can never show under another.

### API

- All existing read endpoints (`/api/summary`, `/api/status`, `/api/live`, `/api/turn`, `/api/turns`, `/api/event`, `/api/item`) accept `?host=<id>`, default `local`. An unknown host id returns `404`.
- Live WebSocket messages carry `host`. Clients ignore messages for other hosts.
- New, this-Mac-only (same `isOwnPage` checks as `/api/setup` for writes):
  - `GET /api/hosts`: list with `id`, `name`, `createdMs`, `lastSeenMs`, plus the local host first.
  - `POST /api/hosts` `{name}`: creates the host, returns the host plus the token and the env block, once.
  - `POST /api/hosts/:id/token`: regenerates, returns the new token and env block, once.
  - `DELETE /api/hosts/:id`.
- The env block is `telemetryEnv()` with the endpoint set to this Mac's Tailscale address and `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>` added. Extend `telemetryEnv` to take an endpoint and optional headers instead of a port only. Detect the Tailscale address from the network interfaces (first address in `100.64.0.0/10`). If none is found, put a clear placeholder in the block and say so in the UI.

### Remote hosts and the Mac's disk

For any host other than `local`, the collector must not read this Mac's disk:

- no `gitRoot()` lookups; `repo` is null. `folder` shows the path the calls touched as sent, shortened only if the remote home can be inferred (otherwise unshortened). The builder may infer a display name from the last path segment, but must not claim it is a git repo.
- no `buildHookDefinitions()` disk reads. Hook commands only exist in config files on disk, so remote hooks show what telemetry carries: event, matcher, source kind (`pluginHook`, `userSettings`, `projectSettings`) and plugin name from `hook_registered` events. No command and no config path (my call).
- `extractPaths()` must not expand `~` with this Mac's `HOME` for remote rows.

The cleanest way is to pass a "host context" (id, home or null, may-read-disk flag) into the functions that need it, rather than branching inside each one. The builder decides the exact shape.

### Menu bar app

- A host picker in the panel header. Selecting a host re-scopes every request (`?host=`), the live feed, the details window and the menu bar label. The label follows the selected host (my call); show the host name next to the number when it is not "This Mac".
- The selection persists in `UserDefaults`. If the saved host disappears, fall back to "This Mac".
- A new "Hosts" settings tab: list (name, last seen or "waiting for data"), Add, Regenerate token, Remove with confirmation. After Add or Regenerate, show the env block once with a Copy button and a note that it will not be shown again.
- The existing collector URL setting stays as it is. It is about where the app reads from, which is unrelated.

### Web dashboard

- A host selector in the header, reflected in the URL (`?host=`), so reloading keeps the selection.
- A hosts section next to the existing setup flow, with the same actions as the app's Hosts tab.

## Constraints

- Bun for the collector and tests (`bun test`), SwiftUI for the app. Follow existing code style and the repo's CLAUDE.md.
- Ship tests for: token auth (missing, wrong, revoked, valid), address filter (loopback, Tailscale v4 and v6, outside), host tagging of stored rows, per-host scoping of every read endpoint, the `Host` check on reads when bound wide, migration of an existing database, and the "no disk reads for remote hosts" rule.
- Verify, do not assume, that Claude Code sends `OTEL_EXPORTER_OTLP_HEADERS` on all three signals for both `http/json` and `http/protobuf`. Check against a real Claude Code session before calling the feature done; this design rests on it.
- Update the README sections on privacy ("listens on 127.0.0.1 only") and setup.

## Left to the builder

- How the collector rebinds when the first host is added or the last removed.
- Exact shape of the host context passed to repo and hook functions.
- UI layout details of the picker and the Hosts tab.
- Throttling of `last_seen_ms` writes.
- Whether IPv6 needs its own listener in Bun.
