/**
 * Core OpenTelemetry setup — initializes tracing (with OpenLLMetry),
 * metrics, and resource configuration.
 *
 * OpenLLMetry auto-instruments Anthropic/OpenAI SDK calls and produces
 * standard OTel spans following the GenAI semantic conventions.
 */

import { trace, metrics } from "@opentelemetry/api";
import type { Tracer, Meter, Counter, Histogram, UpDownCounter } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter as OTLPTraceExporterHTTP } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as OTLPTraceExporterGRPC } from "@opentelemetry/exporter-trace-otlp-grpc";

import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter as OTLPMetricExporterHTTP } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as OTLPMetricExporterGRPC } from "@opentelemetry/exporter-metrics-otlp-grpc";

import type { OtelObservabilityConfig } from "./config.js";

// ── Types ───────────────────────────────────────────────────────────

export interface TelemetryRuntime {
  tracer: Tracer;
  meter: Meter;
  counters: OtelCounters;
  histograms: OtelHistograms;
  gauges: OtelGauges;
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export interface OtelCounters {
  /** Total LLM requests */
  llmRequests: Counter;
  /** Total LLM errors */
  llmErrors: Counter;
  /** Total tokens (prompt + completion) */
  tokensTotal: Counter;
  /** Prompt tokens */
  tokensPrompt: Counter;
  /** Completion tokens */
  tokensCompletion: Counter;
  /** Tool invocations */
  toolCalls: Counter;
  /** Tool errors */
  toolErrors: Counter;
  /** Session resets */
  sessionResets: Counter;
  /** Messages received */
  messagesReceived: Counter;
  /** Messages sent */
  messagesSent: Counter;
  /** Memory search failures */
  memorySearchMiss: Counter;
  /** Memory search successes */
  memorySearchHit: Counter;
  /** Memory write events (only .md files considered as long term memory) */
  memoryWriteEvents: Counter;
  /** Memory read events (only .md files considered as memory) */
  memoryReadEvents: Counter;
  /** Memory edit events (only .md files considered as memory) */
  memoryEditEvents: Counter;

}

export interface OtelHistograms {
  /** LLM request duration in ms */
  llmDuration: Histogram;
  /** Tool execution duration in ms */
  toolDuration: Histogram;
  /** Agent turn duration in ms */
  agentTurnDuration: Histogram;
  /** Session-level memory tool failure rate derived from cached spans */
  memoryFailureRate: Histogram;
  /** Memory search result fragmentation (0 to 1) */
  memorySearchFragmentation: Histogram;
  /** Memory read duration in ms */
  memoryReadDuration: Histogram;
  /** Memory write duration in ms */
  memoryWriteDuration: Histogram;
  /** Memory edit duration in ms */
  memoryEditDuration: Histogram;
  /** Size of system context in bytes */
  contextSystemSize: Histogram;
  /** Size of tool description context in bytes */
  //contextToolDescSize: Histogram; not available at the moment
  /** Size of message history memory context in bytes */
  contextHistoryMemorySize: Histogram;
  /** Size of message history tool context in bytes */
  contextHistoryToolSize: Histogram;
  /** Size of message history user context in bytes */
  contextHistoryUserSize: Histogram;
  /** Size of message history other context in bytes */
  contextHistoryOtherSize: Histogram;
  /** Size of prompt context in bytes */
  contextPromptSize: Histogram;
  /** Size of other context in bytes */
  //contextOtherSize: Histogram; not available at the moment
  /** Duration of context preparation in ms */
  contextPreparationDuration: Histogram;
  /** Repetition score */
  repetitionScore: Histogram;
  /** Parallelisation score */
  parallelisationScore: Histogram;

  /** Experimental metrics - disabled by default */

  /** Novelty score of sub-agent output compared to parent context */
  noveltyScore?: Histogram;
  /** Downstream context sharing score */
  downstreamContextSharing?: Histogram;
}

export interface OtelGauges {
  /** Currently active sessions */
  activeSessions: UpDownCounter;
}

// ── Init ────────────────────────────────────────────────────────────

export function initTelemetry(config: OtelObservabilityConfig, logger: any): TelemetryRuntime {
  const resourceAttrs: Record<string, string> = {
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: "0.1.0",
    "openclaw.plugin": "openclaw-deep-observability",
    ...config.resourceAttributes,
  };

  const resource = resourceFromAttributes(resourceAttrs);

  // Resolve endpoint suffixes for HTTP protocol
  const traceEndpoint =
    config.protocol === "http"
      ? `${config.endpoint}/v1/traces`
      : config.endpoint;
  const metricsEndpoint =
    config.protocol === "http"
      ? `${config.endpoint}/v1/metrics`
      : config.endpoint;

  // ── Tracing ─────────────────────────────────────────────────────

  let tracerProvider: NodeTracerProvider | undefined;

  if (config.traces) {
    const traceExporter =
      config.protocol === "grpc"
        ? new OTLPTraceExporterGRPC({ url: traceEndpoint, headers: config.headers })
        : new OTLPTraceExporterHTTP({ url: traceEndpoint, headers: config.headers });

    // SDK v2: pass spanProcessors in constructor (addSpanProcessor was removed)
    tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(traceExporter)],
    });
    tracerProvider.register();

    logger.info(`[otel] Trace exporter → ${traceEndpoint} (${config.protocol})`);
  }

  // ── Metrics ─────────────────────────────────────────────────────

  let meterProvider: MeterProvider | undefined;

  if (config.metrics) {
    const metricExporter =
      config.protocol === "grpc"
        ? new OTLPMetricExporterGRPC({ url: metricsEndpoint, headers: config.headers })
        : new OTLPMetricExporterHTTP({ url: metricsEndpoint, headers: config.headers });

    meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: config.metricsIntervalMs,
        }),
      ],
    });

    // Register as global meter provider so metrics.getMeter() returns a real meter
    metrics.setGlobalMeterProvider(meterProvider);

    logger.info(`[otel] Metrics exporter → ${metricsEndpoint} (${config.protocol}, interval=${config.metricsIntervalMs}ms)`);
  }

  // ── Instruments ─────────────────────────────────────────────────

  const tracer = trace.getTracer("openclaw-deep-observability", "0.1.0");
  const meter = metrics.getMeter("openclaw-deep-observability", "0.1.0");

  const counters: OtelCounters = {
    llmRequests: meter.createCounter("openclaw.llm.requests", {
      description: "Total LLM API requests",
      unit: "requests",
    }),
    llmErrors: meter.createCounter("openclaw.llm.errors", {
      description: "Total LLM API errors",
      unit: "errors",
    }),
    tokensTotal: meter.createCounter("openclaw.llm.tokens.total", {
      description: "Total tokens consumed (prompt + completion)",
      unit: "tokens",
    }),
    tokensPrompt: meter.createCounter("openclaw.llm.tokens.prompt", {
      description: "Prompt tokens consumed",
      unit: "tokens",
    }),
    tokensCompletion: meter.createCounter("openclaw.llm.tokens.completion", {
      description: "Completion tokens consumed",
      unit: "tokens",
    }),
    toolCalls: meter.createCounter("openclaw.tool.calls", {
      description: "Total tool invocations",
      unit: "calls",
    }),
    toolErrors: meter.createCounter("openclaw.tool.errors", {
      description: "Total tool errors",
      unit: "errors",
    }),
    sessionResets: meter.createCounter("openclaw.session.resets", {
      description: "Total session resets",
      unit: "resets",
    }),
    messagesReceived: meter.createCounter("openclaw.messages.received", {
      description: "Total inbound messages",
      unit: "messages",
    }),
    messagesSent: meter.createCounter("openclaw.messages.sent", {
      description: "Total outbound messages",
      unit: "messages",
    }),

    // Memory operation counters
    memoryWriteEvents: meter.createCounter("openclaw.memory.write_events", {
      description: "Memory write events (only .md files considered as long term memory)",
      unit: "events",
    }),
    memoryReadEvents: meter.createCounter("openclaw.memory.read_events", {
      description: "Memory read events (only .md files considered as memory)",
      unit: "events",
    }),
    memoryEditEvents: meter.createCounter("openclaw.memory.edit_events", {
        description: "Memory edit events (only .md files considered as memory)",
        unit: "events",
        }),
    memorySearchMiss: meter.createCounter("openclaw.memory.search_miss", {
      description: "Memory search misses",
      unit: "events",
    }),
    memorySearchHit: meter.createCounter("openclaw.memory.search_hit", {
      description: "Memory search hits",
      unit: "events",
    }),
  };

  const histograms: OtelHistograms = {
    llmDuration: meter.createHistogram("openclaw.llm.duration", {
      description: "LLM request duration",
      unit: "ms",
    }),
    toolDuration: meter.createHistogram("openclaw.tool.duration", {
      description: "Tool execution duration",
      unit: "ms",
    }),
    agentTurnDuration: meter.createHistogram("openclaw.agent.turn_duration", {
      description: "Full agent turn duration (LLM + tools)",
      unit: "ms",
    }),
    memoryFailureRate: meter.createHistogram("openclaw.memory.failure_rate", {
      description: "Failure rate of memory access operations within the current session derived from cached spans",
      unit: "1",
    }),
    memorySearchFragmentation: meter.createHistogram("openclaw.memory.search_fragmentation", {
      description: "Memory search result fragmentation (0 to 1)",
      unit: "1",
    }),
    memoryReadDuration: meter.createHistogram("openclaw.memory.read_duration", {
      description: "Memory read duration in ms",
      unit: "ms",
    }),
    memoryWriteDuration: meter.createHistogram("openclaw.memory.write_duration", {
      description: "Memory write duration in ms",
      unit: "ms",
    }),
    memoryEditDuration: meter.createHistogram("openclaw.memory.edit_duration", {
        description: "Memory edit duration in ms",
        unit: "ms",
    }),
    contextSystemSize: meter.createHistogram("openclaw.context.system_size", {
        description: "Size of system context in bytes",
        unit: "bytes",
    }),
    contextHistoryMemorySize: meter.createHistogram("openclaw.context.history_memory_size", {
        description: "Size of message history memory context in bytes",
        unit: "bytes",
    }), 
    contextHistoryToolSize: meter.createHistogram("openclaw.context.history_tool_size", {
        description: "Size of message history tool context in bytes",
        unit: "bytes",
    }), 
    contextHistoryUserSize: meter.createHistogram("openclaw.context.history_user_size", {
        description: "Size of message history user context in bytes",
        unit: "bytes",
    }),
     contextHistoryOtherSize: meter.createHistogram("openclaw.context.history_other_size", {
        description: "Size of message history other context in bytes",
        unit: "bytes",
    }),
    contextPromptSize: meter.createHistogram("openclaw.context.prompt_size", {
        description: "Size of prompt context in bytes",
        unit: "bytes",
    }),
    contextPreparationDuration: meter.createHistogram("openclaw.context.preparation_duration", {
        description: "Duration of context preparation in ms",
        unit: "ms",
    }),
    parallelisationScore: meter.createHistogram("openclaw.session.parallelisation_score", {
        description: "Parallelisation score",
        unit: "1",
    }),
    repetitionScore: meter.createHistogram("openclaw.session.repetition_score", {
        description: "Repetition score",
        unit: "1",
    })
  };
  
  if (config.experimentalMetrics) {
      histograms.noveltyScore = meter.createHistogram("openclaw.agent.novelty_score", {
          description: "Novelty score of sub-agent output compared to parent context",
          unit: "1",
      });
      histograms.downstreamContextSharing = meter.createHistogram("openclaw.agent.downstream_context_sharing", {
          description: "Downstream context sharing score",
          unit: "1",
      });
    }
    


  const gauges: OtelGauges = {
    activeSessions: meter.createUpDownCounter("openclaw.sessions.active", {
      description: "Currently active sessions",
      unit: "sessions",
    }),
  };

  // ── Periodic Metric Heartbeat ─────────────────────────────────
  // OTel counters only emit data points when .add() is called.
  // To maintain continuous timeseries (important for Dynatrace),
  // we periodically emit zero-value data points on all counters.
  // This ensures metrics always have data, even during idle periods.

  const metricHeartbeatInterval = setInterval(() => {
    try {
      const idleAttrs = { "openclaw.idle": true };

      // Core counters — emit 0 to keep timeseries alive
      counters.llmRequests.add(0, idleAttrs);
      counters.llmErrors.add(0, idleAttrs);
      counters.tokensTotal.add(0, idleAttrs);
      counters.tokensPrompt.add(0, idleAttrs);
      counters.tokensCompletion.add(0, idleAttrs);
      counters.toolCalls.add(0, idleAttrs);
      counters.toolErrors.add(0, idleAttrs);
      counters.messagesReceived.add(0, idleAttrs);
      counters.messagesSent.add(0, idleAttrs);
      counters.sessionResets.add(0, idleAttrs);

      // Memory operation counters
      counters.memorySearchMiss.add(0, idleAttrs);
      counters.memorySearchHit.add(0, idleAttrs);
      counters.memoryWriteEvents.add(0, idleAttrs);
      counters.memoryReadEvents.add(0, idleAttrs);
      counters.memoryEditEvents.add(0, idleAttrs);
    } catch {
      // Never let metric heartbeat errors affect the gateway
    }
  }, config.metricsIntervalMs || 30_000); // Match the export interval

  const forceFlush = async () => {
    if (!tracerProvider) {
      return;
    }

    try {
      await tracerProvider.forceFlush();
    } catch (err) {
      logger.warn?.(`[otel] Trace forceFlush error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // ── Shutdown ────────────────────────────────────────────────────

  const shutdown = async () => {
    logger.info("[otel] Shutting down telemetry...");
    clearInterval(metricHeartbeatInterval);
    try {
      await forceFlush();
      if (tracerProvider) await tracerProvider.shutdown();
      if (meterProvider) await meterProvider.shutdown();
    } catch (err) {
      logger.error(`[otel] Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return { tracer, meter, counters, histograms, gauges, forceFlush, shutdown };
}