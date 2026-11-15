// DeepSeek Harness plugin: streams every live session event to the analyzer collector.
// Load it from ~/.dsh/cordis.patch.yml:
//   - insert:
//       - id: cpa-telemetry
//         name: "file:///<repo>/apps/dsh-telemetry/src/index.js"
// Endpoint and auth come from CPA_OTLP_ENDPOINT (default http://127.0.0.1:4318) and
// CPA_OTLP_HEADERS ("Authorization=Bearer cpa_..."), or from the row's config.
import { Exporter } from "./exporter.js";
import { SessionMapper } from "./map.js";

export const name = "cpa-dsh-telemetry";

/** @param {string | undefined} raw */
export function parseHeaders(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of (raw ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** @param {string} endpoint */
export function logsUrl(endpoint) {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith("/v1/logs") ? base : `${base}/v1/logs`;
}

/**
 * @param {any} ctx
 * @param {{ endpoint?: string, headers?: string, intervalMs?: number, disabled?: boolean } | undefined} config
 */
export function apply(ctx, config = {}) {
  const cfg = config ?? {};
  if (cfg.disabled || process.env.CPA_DSH_TELEMETRY_DISABLED) return;
  const exporter = new Exporter({
    url: logsUrl(cfg.endpoint ?? process.env.CPA_OTLP_ENDPOINT ?? "http://127.0.0.1:4318"),
    headers: parseHeaders(cfg.headers ?? process.env.CPA_OTLP_HEADERS),
    intervalMs: cfg.intervalMs ?? 1000,
    warn: (msg) => (ctx.logger?.warn ? ctx.logger.warn(msg) : console.warn(msg)),
  });
  /** @type {WeakMap<object, SessionMapper>} */
  const mappers = new WeakMap();

  /** @param {any} session */
  const mapperFor = (session) => {
    let m = mappers.get(session);
    if (!m) {
      const h = session.header ?? {};
      m = new SessionMapper({ ...h, id: String(session.id ?? h.id) });
      mappers.set(session, m);
    }
    return m;
  };

  ctx.on("session/event", (session, event) => {
    // Telemetry must never break the agent loop.
    try {
      const m = mapperFor(session);
      exporter.push(m.resource(), m.map(event));
    } catch (err) {
      exporter.warn(`cpa-dsh-telemetry: skipped ${event?.type}: ${String(err)}`);
    }
  });

  ctx.on("session/flush", () => void exporter.flush());

  ctx.effect(() => () => exporter.shutdown(), "cpa telemetry export");
}
