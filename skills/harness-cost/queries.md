# harness_query recipes

`harness_query` runs one SELECT (or WITH) over SQLite. It returns at most 100 rows, cuts cells at 160 characters and stops after 10 seconds. The table list is in the tool description.

## Two traps

- **`tel.*` is not scoped.** `blocks`, `hook_runs` and `sessions` follow the `session`, `since` and `project` arguments. `tel.events`, `tel.spans` and `tel.metrics` hold every session the collector ever recorded, from every config dir and host. Filter `ts_ms` yourself and `JOIN sessions` to match what the named tools report.
- **Telemetry numbers are stored as text.** `json_extract(attrs, '$.total_duration_ms')` sorts "998" above "10592". Wrap numbers in `CAST(... AS INTEGER)` before sorting or comparing.

Useful `attrs` keys on `tel.events` rows with `name = 'hook_execution_complete'`: `hook_event`, `hook_name`, `num_hooks`, `total_duration_ms`, `additional_context_chars`, `stdout_chars`, `num_blocking`, `num_cancelled`, `num_outputs_persisted`, `prompt.id`.

## Hindsight per project

With `session: "all"`, `since: "7d"`:

```sql
SELECT project, count(*) AS blocks, sum(chars) AS chars, sum(est_tokens) AS est_tok,
       sum(repeat) AS repeats, sum(persisted_size IS NOT NULL) AS too_large, sum(read_back) AS read_back
FROM blocks WHERE family = 'hindsight'
GROUP BY project ORDER BY est_tok DESC LIMIT 10
```

## Was oversized output ever read?

```sql
SELECT coalesce(tag, hook_event) AS source, count(*) AS too_large, sum(read_back) AS read_back,
       round(100.0 * sum(read_back) / count(*)) AS pct_read
FROM blocks WHERE persisted_size IS NOT NULL
GROUP BY 1 ORDER BY too_large DESC
```

## Repeated text that costs the most

```sql
SELECT hook_event, substr(preview, 1, 50) AS text, count(*) AS repeats, sum(est_tokens) AS est_tok
FROM blocks WHERE repeat = 1
GROUP BY signature ORDER BY est_tok DESC LIMIT 10
```

## Slowest single hook firings, in the tools' scope

With `session: "all"`, `since: "7d"`:

```sql
SELECT e.session_id, s.project, json_extract(e.attrs, '$.hook_name') AS hook,
       CAST(json_extract(e.attrs, '$.total_duration_ms') AS INTEGER) AS ms,
       json_extract(e.attrs, '$.num_hooks') AS hooks_run
FROM tel.events e JOIN sessions s ON s.session_id = e.session_id
WHERE e.name = 'hook_execution_complete'
  AND e.ts_ms > (strftime('%s', 'now') - 7 * 86400) * 1000
ORDER BY ms DESC LIMIT 10
```
