//  Copyright (c) 2026 Cisco Systems, Inc. and its affiliates
//  SPDX-License-Identifier: Apache-2.0

/**
 * Configuration types and defaults for the OTel Observability plugin.
 */

export interface OtelObservabilityConfig {
  /** OTLP endpoint URL */
  endpoint: string;
  /** OTLP export protocol: 'http' (OTLP/HTTP) or 'grpc' (OTLP/gRPC) */
  protocol: "http" | "grpc";
  /** OpenTelemetry service name */
  serviceName: string;
  /** Custom headers for OTLP export (e.g., Authorization for Dynatrace) */
  headers: Record<string, string>;
  /** Enable trace export */
  traces: boolean;
  /** Enable metrics export */
  metrics: boolean;
  /** Enable experimental metrics */
  experimentalMetrics: boolean;
  /** Enable log export */
  logs: boolean;
  /** Capture prompt/completion content in spans (disable for privacy) */
  captureContent: boolean;
  /** Enable the in-process span attribute cache for derived metrics/lookups */
  spanCache: boolean;
  /** Promote span-cache maintenance and lookup logs to info level */
  spanCacheVerboseLogs: boolean;
  /** Metrics export interval in milliseconds */
  metricsIntervalMs: number;
  /** Additional OTel resource attributes */
  resourceAttributes: Record<string, string>;
  /** Additional span attributes applied only to the openclaw.request root span */
  customAttributes: Record<string, string | number | boolean>;
  /** Enable processing of embeddings for context analysis (novelty, similarity) */
  embeddingsProcessing: boolean;
  /** Emit ioa_observe.* IOA-specific attributes (entity payload, fork/join, handoff sequences). Disable to emit only OTel GenAI semconv. */
  emitIoaObserveAttributes: boolean;
}

const DEFAULTS: OtelObservabilityConfig = {
  endpoint: "http://localhost:4318",
  protocol: "http",
  serviceName: "openclaw-gateway",
  headers: {},
  traces: true,
  metrics: true,
  experimentalMetrics: false,
  logs: true,
  captureContent: false,
  spanCache: false,
  spanCacheVerboseLogs: false,
  metricsIntervalMs: 30_000,
  resourceAttributes: {},
  customAttributes: {},
  embeddingsProcessing: false,
  emitIoaObserveAttributes: true,
};

function parsePrimitiveAttributeRecord(
  value: unknown
): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => {
      const entryType = typeof entryValue;
      return entryType === "string" || entryType === "number" || entryType === "boolean";
    })
  ) as Record<string, string | number | boolean>;
}

export function parseConfig(raw: unknown): OtelObservabilityConfig {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const customAttributes = parsePrimitiveAttributeRecord(obj.customAttributes);

  return {
    endpoint: typeof obj.endpoint === "string" ? obj.endpoint : DEFAULTS.endpoint,
    protocol: obj.protocol === "grpc" ? "grpc" : DEFAULTS.protocol,
    serviceName:
      typeof obj.serviceName === "string" ? obj.serviceName : DEFAULTS.serviceName,
    headers:
      obj.headers && typeof obj.headers === "object" && !Array.isArray(obj.headers)
        ? (obj.headers as Record<string, string>)
        : DEFAULTS.headers,
    traces: typeof obj.traces === "boolean" ? obj.traces : DEFAULTS.traces,
    metrics: typeof obj.metrics === "boolean" ? obj.metrics : DEFAULTS.metrics,
    experimentalMetrics:
      typeof obj.experimentalMetrics === "boolean" ? obj.experimentalMetrics : DEFAULTS.experimentalMetrics,
    logs: typeof obj.logs === "boolean" ? obj.logs : DEFAULTS.logs,
    captureContent:
      typeof obj.captureContent === "boolean" ? obj.captureContent : DEFAULTS.captureContent,
    spanCache: typeof obj.spanCache === "boolean" ? obj.spanCache : DEFAULTS.spanCache,
    spanCacheVerboseLogs:
      typeof obj.spanCacheVerboseLogs === "boolean"
        ? obj.spanCacheVerboseLogs
        : DEFAULTS.spanCacheVerboseLogs,
    metricsIntervalMs:
      typeof obj.metricsIntervalMs === "number" && obj.metricsIntervalMs >= 1000
        ? obj.metricsIntervalMs
        : DEFAULTS.metricsIntervalMs,
    resourceAttributes:
      obj.resourceAttributes &&
      typeof obj.resourceAttributes === "object" &&
      !Array.isArray(obj.resourceAttributes)
        ? (obj.resourceAttributes as Record<string, string>)
        : DEFAULTS.resourceAttributes,
    customAttributes,
    embeddingsProcessing:
      typeof obj.embeddingsProcessing === "boolean"
        ? obj.embeddingsProcessing
        : DEFAULTS.embeddingsProcessing,
    emitIoaObserveAttributes:
      typeof obj.emitIoaObserveAttributes === "boolean"
        ? obj.emitIoaObserveAttributes
        : DEFAULTS.emitIoaObserveAttributes,
  };
}
