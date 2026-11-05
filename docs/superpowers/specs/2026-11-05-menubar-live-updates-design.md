# Live updates in the menu bar app: design

Date: 2026-11-05. Status: draft, awaiting approval.

## Intent

The menu bar panel updates in 2 second steps. Nothing moves, then a poll lands and everything changes at once: several feed rows slide in together, every number rolls, the chart morphs, then stillness until the next tick. The user's words: it does not feel smooth, it feels like a 2010 app.

The target is a panel that looks alive while Claude Code works. Events show up the moment the collector has them, one message at a time. Work that is in progress visibly counts up. Aggregates follow a beat later, never in a storm.

The web dashboard already works this way: it listens on the collector's WebSocket for the live feed, reloads the summary when a push says something changed, and polls only as a fallback. This design brings the Swift app to the same model.

## Goals

- Pushed events appear in the panel's Live section as soon as the collector ingests them, without waiting for a poll tick.
- The menu bar label, the summary, the turns list and the selected turn refresh shortly after a push, coalesced so a burst of events causes one refetch, not one per event.
- A hook that has started and not finished shows a ticking elapsed time in the panel.
- Nothing wakes up while nothing happens: no animation timers while idle, and no fast polling while the socket is healthy. One slow refresh every 30 s remains, because several values age with time alone (see constraints).
- When the socket is down, the panel keeps working on that slow refresh and says so in the header.
- The animation setting (on, off, follow system) still governs every motion this adds.

## Non-goals

- Pushing aggregates (summary, status, turns) over the socket. The app refetches them. The collector's message format stays as it is; the only collector change is publishing that same frame for trace and metric batches (section 5).
- Assigning database ids to pushed rows in the collector. Click-through ids arrive with the coalesced refetch instead (section 3).
- Changing the dashboard. It already behaves this way, and it picks up the trace and metric frames for free.
- Lowering Claude Code's export interval. See constraints.
- Streaming anything to remote machines. Reads stay on this Mac.

## Anti-goals

- A panel that animates constantly or burns CPU while Claude is idle. If Activity Monitor shows the app busy with the panel closed and nothing running, this failed.
- A storm of refetches during a busy turn. Dozens of events per second must not mean dozens of summary queries per second.
- Stale data shown under the wrong host or collector after a switch. The existing request-context guards must hold for pushed data too.
- Losing events silently while reconnecting. A reconnect must resync.

## Constraints

- **Export cadence.** Claude Code batches its OTLP log export. The collector's setup writes `OTEL_LOGS_EXPORT_INTERVAL=1000`, so events reach the collector in batches up to 1 second apart. Push cuts panel latency from "up to 1 s plus up to 2 s poll" to "up to 1 s", and the batch arrives as one message. Per-event arrival finer than 1 second would need a lower export interval, which is left out of this design. The ticking elapsed counter is what gives continuity between batches.
- **Socket message shape**, as the collector publishes it today (`apps/collector/src/http.ts`, `broadcast`): one JSON text frame per ingested logs batch, `{ "type": "events", "host": <hostId>, "events": [LiveEvent...], "changed": <rows stored> }`. `events` holds only rows worth watching (the `liveEvent` mapping in `packages/analytics`), `changed` counts every stored row, so `changed > 0` with an empty `events` list still means aggregates moved. The socket carries every host; the client filters by its selected host, as the dashboard does in `liveForHost`.
- **Only logs publish today.** Trace and metric batches are stored without a frame (`ingest` in `apps/collector/src/http.ts`). Summary values such as TTFT and turn timing come from spans, so a trace batch landing after the last log-triggered refetch would otherwise go unseen until the next log push or the 30 s refresh.
- **Pushed rows carry no id.** The collector inserts events without reading the row id back, and `broadcast` maps the parsed rows, so every pushed `LiveEvent` has `id: null`. The native feed shows a click-through chevron only when `id` is set. Ids are present in `/api/live` responses, which read from the database.
- **Values that age with time.** The status label falls to `idle` 15 minutes after the last API request, the summary window rolls forward, and a turn's `inProgress` flag clears 15 s after its last event. None of these produce a push. The dashboard handles this with an unconditional 30 s reload.
- **Socket access.** `/ws` is accepted when the `Host` header is the collector's own and `Origin` is absent or the collector's own origin (`isOwnSocket`). A `URLSessionWebSocketTask` sends no `Origin`, so the native client passes without collector changes.
- **Client platform.** SwiftUI on macOS 14, `@Observable` model on the main actor, structured concurrency. The model is `apps/menubar/Sources/Networking/Telemetry.swift`.
- **Tests.** Swift tests compile the production sources with an executable harness and run them under `bun test` (`apps/menubar/test/*.test.ts` spawn `swiftc`). HTTP is mocked with a `URLProtocol` subclass. A `URLProtocol` cannot intercept a WebSocket task, so the socket must sit behind an injectable seam.
- **Writing style.** Comments and docs follow the repository's plain style: short, no long dashes.

## Design

### 1. One long-lived socket

The app opens a WebSocket to `<collectorURL>/ws` when the model starts and keeps it open for the app's lifetime, panel open or closed. It replaces the always-on 2 s status poll, so the app does less network work than today while idle.

- Connect on model start, on collector URL change (the old socket closes first), and after any close.
- Reconnect with backoff starting at 1 s, doubling, capped at 15 s, reset to 1 s after a successful open. Same numbers as the dashboard.
- Connection state is one of `live`, `reconnecting`, `offline`. `offline` is entered after the first failed attempt, `reconnecting` while a retry is pending with a previously good connection, `live` on open. Only `live` suppresses the fallback poll.
- The socket task is created through an injected factory, like `makeSession` today, so tests can hand the model a fake socket that yields scripted frames and records opens, closes and reconnect attempts.

### 2. Resync on every open

Pushes carry only what happened after the socket opened. Every transition into `live` runs one full fetch of status, hosts and, if the panel is open, summary, live and turns. This is the same code path the first poll tick runs today.

### 3. Pushed events feed the panel directly

On each frame:

1. Parse. Drop anything that is not `type == "events"` or whose `host` is not the selected host id. Malformed frames are dropped and counted, never crash the model.
2. If `events` is non-empty, prepend them (newest first) to `live`, cap the array at the same length `/api/live` returns (60), and apply the change inside one `withAnimation(panelAnimation())`. One frame is one animated change. Pushed rows have no `id`, so they render without the detail chevron until the coalesced refetch (section 4) replaces the list with the database copy, which carries ids. Row identity in the view is the existing `rowIds` key (timestamp, session, kind, label), so the replacement does not move or re-animate rows, only the chevron appears. Duplicates by that same key are not inserted twice (a resync fetch and a push can overlap).
3. If `changed > 0`, mark aggregates dirty (section 4).
4. Track in-flight hooks (section 6).

The request-context guard applies to pushes as well: a frame is handled against the context captured when the socket opened, and a host or collector switch discards the socket's buffered frames along with everything else `invalidateTelemetry` clears.

### 4. Coalesced refetch of aggregates

A dirty mark starts a debounce: refetch 300 ms after the last mark, but never later than 1 s after the first mark in a burst, so a steady stream still refreshes once a second. Each refetch is the existing `refreshStatus` plus, when the panel is open, the existing `refreshPanel` (summary, live, turns and the selected turn). The `/api/live` request stays in: it is the step that gives pushed rows their ids. Only one coalesced refetch is in flight at a time; a mark arriving mid-flight schedules exactly one more.

The 300 ms and 1 s values are constants, not settings.

### 5. Collector publishes for traces and metrics too

`ingest` in `apps/collector/src/http.ts` publishes a frame only on the logs branch. The traces and metrics branches gain the same call with an empty `events` list and `changed` set to the number of rows stored: `{ "type": "events", "host": <hostId>, "events": [], "changed": <n> }`. No new message type. The Swift client treats it as a dirty mark (section 3, step 3). The dashboard's `liveForHost` already accepts this shape and reloads on `changed > 0`, so it benefits without changes. One collector test covers each branch.

### 6. In-flight work ticks

The feed already contains `hook_start` and `hook` (complete) events. The model keeps a map of started hooks not yet completed, keyed by session id and hook label, exactly as the dashboard's `RunningHooks` does, with the same staleness cutoff so a hook whose completion never arrives falls out.

While that map is non-empty and the panel is open, the Live section shows one line per running hook with its elapsed time, updated on a timer (4 Hz is enough for a tenth-of-a-second display; the builder chooses). The timer starts when the map becomes non-empty and stops when it empties or the panel closes. No timer runs otherwise.

If animations are off (setting or Reduce Motion), the counter still updates. It is information, not decoration.

### 7. Slow refresh, always on

The status and panel polling loops stay, with two changes:

- Their interval is a fixed 30 s, in every connection state. While `live` this is the window roll: it lets the status fall to idle, the summary window move forward and `inProgress` clear when no push arrives. While not `live` it is the only source of data. The same loop serves both, so there is one mechanism, not two.
- The "Status poll interval" and "Panel poll interval" settings and their steppers are removed, with their stored values cleaned up by `resetAllSettings` and dropped from `Prefs.Key.allManaged`. The request timeout and retry delay settings stay.

A coalesced refetch (section 4) resets the 30 s timer, so a busy panel never runs the slow refresh on top of the push-driven ones.

The host list poll (10 s, independent of panel state) is unchanged. A host added or removed elsewhere is not pushed on the socket today, and that is fine.

### 8. Header

The header's state line gains the connection state: `Live` beside the existing status text when the socket is open, `Reconnecting` or `Offline, polling` otherwise. The "updated N ago" text stays and now reflects the last push or refetch.

### 9. Documentation

`docs/menu-bar-app.md` currently says "The panel polls only while it is open" and lists polling intervals among the settings. Both sentences are updated to describe live updates and the 30 s refresh. The remote hosts plan note "Swift uses polling for live data, not WebSockets. Keep that design." is historical and stays as written.

## What the builder decides

- The socket abstraction's exact shape (protocol, closure, or an actor) and how a fake socket drives scripted frames in tests.
- Where the in-flight hook map and the coalescing timer live (inside `Telemetry` or a small helper type).
- Timer mechanism for the elapsed counter (`Task` sleep loop or `TimelineView`), as long as it stops when idle.
- Exact header wording and placement within the existing header layout.
- How the chevron appears on a row once the refetch supplies its id (plain state change or a short fade).

## Acceptance

Automated, in the Swift harness with a fake socket and the existing mock HTTP:

- A pushed frame for the selected host appears in `live` before any `/api/live` request completes; after the coalesced refetch the same row carries the id the mock `/api/live` returned.
- A frame for another host changes nothing.
- Ten frames with `changed > 0` within 300 ms cause exactly one `/api/summary` request after the burst; a steady stream of frames over 3 s causes about three.
- A frame with an empty `events` list and `changed > 0` triggers a refetch.
- A host switch between a frame's arrival and its handling drops the frame.
- Socket open triggers one resync fetch; while `live` and quiet, the only status or summary requests over a 10 s window are that resync (the 30 s refresh sits outside the window).
- Socket close moves the state off `live`; the 30 s refresh keeps running.
- Collector: a traces batch and a metrics batch each publish one frame with empty `events` and `changed` equal to the rows stored, for the right host id.
- A `hook_start` with no matching `hook` puts one entry in the running map; the matching `hook` removes it; an entry older than the staleness cutoff is removed on the next tick.
- With the panel closed and the running map empty, no timer task exists.

Manual, on the built app against the real collector:

- Run a Claude Code turn with hooks. Rows appear within about a second of the hook finishing, one batch per export, and a running hook shows a counting elapsed time.
- Stop the collector: header shows the offline state, panel keeps the last data, and resumes within the backoff once the collector returns.
- Switch host in Settings while a turn runs on the old host: nothing from the old host appears afterwards.

## Risks

- A push racing a refetch can reorder the feed briefly. Deduplication by row key and the newest-first sort on insert bound this to a visual blip.
- A pushed row shows its detail chevron only after the refetch, up to about a second later. Acceptable; assigning ids at insert time in the collector is the follow-up if it ever bothers anyone.
- The socket is shared across hosts, so a busy remote host causes frame parsing on this Mac even when another host is selected. Frames are small and parsing is cheap. If it ever matters, the collector could accept a host filter on `/ws`, out of scope here.
- Removing two settings is a visible change for anyone who tuned them. Their values are ignored and cleaned up, not migrated.
