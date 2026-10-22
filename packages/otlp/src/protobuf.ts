// Decodes OTLP http/protobuf bodies into the same object shape as OTLP http/json.
import protobuf from "protobufjs";
// Text imports put the schemas inside a compiled binary, which has no proto/ directory beside it.
// Apache-2.0, see proto/LICENSE.
import commonProto from "../proto/opentelemetry/proto/common/v1/common.proto" with { type: "text" };
import resourceProto from "../proto/opentelemetry/proto/resource/v1/resource.proto" with { type: "text" };
import logsProto from "../proto/opentelemetry/proto/logs/v1/logs.proto" with { type: "text" };
import metricsProto from "../proto/opentelemetry/proto/metrics/v1/metrics.proto" with { type: "text" };
import traceProto from "../proto/opentelemetry/proto/trace/v1/trace.proto" with { type: "text" };
import logsServiceProto from "../proto/opentelemetry/proto/collector/logs/v1/logs_service.proto" with { type: "text" };
import metricsServiceProto from "../proto/opentelemetry/proto/collector/metrics/v1/metrics_service.proto" with { type: "text" };
import traceServiceProto from "../proto/opentelemetry/proto/collector/trace/v1/trace_service.proto" with { type: "text" };

// Every file the three services import, so parsing them into one root resolves all types.
const SOURCES = [commonProto, resourceProto, logsProto, metricsProto, traceProto, logsServiceProto, metricsServiceProto, traceServiceProto];
const SERVICES = {
  logs: "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest",
  metrics: "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest",
  traces: "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
} as const;
export type Signal = keyof typeof SERVICES;

let root: protobuf.Root | null = null;
function load(): protobuf.Root {
  if (root) return root;
  const r = new protobuf.Root();
  for (const source of SOURCES) protobuf.parse(source, r);
  r.resolveAll();
  return (root = r);
}

export function requestType(signal: Signal): protobuf.Type {
  return load().lookupType(SERVICES[signal]);
}

// OTLP/JSON writes trace and span ids as hex; protobuf carries raw bytes.
const ID_FIELDS = new Set(["traceId", "spanId", "parentSpanId"]);
function hexIds(value: any): any {
  if (Array.isArray(value)) return value.map(hexIds);
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (ID_FIELDS.has(k) && typeof v === "string") value[k] = Buffer.from(v, "base64").toString("hex");
      else hexIds(v);
    }
  }
  return value;
}

export function decodeOtlp(signal: Signal, bytes: Uint8Array): any {
  const type = requestType(signal);
  return hexIds(type.toObject(type.decode(bytes), { longs: String, enums: Number, bytes: String, defaults: false }));
}
