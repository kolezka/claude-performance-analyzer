// Batches mapped records per session and posts them to the collector as OTLP http/json logs.
// Delivery is best effort: a failed post is retried a few times, then dropped with a warning,
// and the queue is capped so a stopped collector can never grow memory without bound.

const MAX_QUEUE = 20_000;
const MAX_ATTEMPTS = 3;

/** @param {string | number | boolean} v */
function anyValue(v) {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: v } : { doubleValue: v };
  return { stringValue: String(v) };
}

/** @param {Record<string, string | number | boolean>} attrs */
function keyValues(attrs) {
  return Object.entries(attrs).map(([key, value]) => ({ key, value: anyValue(value) }));
}

/**
 * @param {Map<string, { resource: Record<string, string | number | boolean>, records: import("./map.js").MappedRecord[] }>} batches
 */
export function otlpLogsBody(batches) {
  const resourceLogs = [];
  for (const { resource, records } of batches.values()) {
    if (!records.length) continue;
    resourceLogs.push({
      resource: { attributes: keyValues(resource) },
      scopeLogs: [
        {
          scope: { name: "cpa-dsh-telemetry" },
          logRecords: records.map((r) => ({
            timeUnixNano: String(BigInt(Math.round(r.tsMs)) * 1_000_000n),
            body: { stringValue: r.name },
            attributes: keyValues({ ...r.attrs, "event.name": r.name, "event.timestamp": new Date(r.tsMs).toISOString() }),
          })),
        },
      ],
    });
  }
  return { resourceLogs };
}

export class Exporter {
  /**
   * @param {{ url: string, headers?: Record<string, string>, intervalMs?: number, fetch?: typeof fetch, warn?: (msg: string) => void }} options
   */
  constructor(options) {
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.fetch = options.fetch ?? globalThis.fetch;
    this.warn = options.warn ?? ((msg) => console.warn(msg));
    /** @type {Map<string, { resource: Record<string, string | number | boolean>, records: import("./map.js").MappedRecord[] }>} */
    this.pending = new Map();
    this.size = 0;
    this.dropped = 0;
    this.failures = 0;
    /** @type {Promise<void>} */
    this.inflight = Promise.resolve();
    this.timer = setInterval(() => void this.flush(), options.intervalMs ?? 1000);
    this.timer.unref?.();
  }

  /** @param {Record<string, string | number | boolean>} resource @param {import("./map.js").MappedRecord[]} records */
  push(resource, records) {
    if (!records.length) return;
    if (this.size + records.length > MAX_QUEUE) {
      this.dropped += records.length;
      return;
    }
    const key = String(resource["session.id"]);
    const batch = this.pending.get(key) ?? { resource, records: [] };
    batch.records.push(...records);
    this.pending.set(key, batch);
    this.size += records.length;
  }

  /** Sends everything queued so far. Posts run one at a time so records arrive in order. */
  flush() {
    if (!this.size) return this.inflight;
    const batches = this.pending;
    this.pending = new Map();
    this.size = 0;
    this.inflight = this.inflight.then(() => this.send(batches));
    return this.inflight;
  }

  /** @param {Map<string, any>} batches */
  async send(batches) {
    const body = JSON.stringify(otlpLogsBody(batches));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.headers },
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          if (this.failures) this.warn(`cpa-dsh-telemetry: collector reachable again after ${this.failures} failed posts`);
          this.failures = 0;
          return;
        }
        // 4xx will not get better on retry (bad token, bad body).
        if (res.status < 500) {
          this.warn(`cpa-dsh-telemetry: collector rejected batch with HTTP ${res.status}`);
          return;
        }
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) {
          // Warn once per outage, not once per second.
          if (this.failures++ === 0) this.warn(`cpa-dsh-telemetry: cannot reach ${this.url}: ${String(err)}`);
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }

  async shutdown() {
    clearInterval(this.timer);
    await this.flush();
    if (this.dropped) this.warn(`cpa-dsh-telemetry: dropped ${this.dropped} records because the queue was full`);
  }
}
