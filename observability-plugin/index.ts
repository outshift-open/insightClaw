/**
 * OpenClaw Deep Observability Plugin
 *
 * Provides full OpenTelemetry Deep Observability for OpenClaw:
 *   - Connected distributed traces (request → agent turn → tools)
 *   - Cost tracking via OpenClaw diagnostic events integration
 *   - Token usage (input, output, cache read/write) as spans + metrics
 *   - Tool execution spans with result metadata
 *   - Metrics: token usage, cost, latency histograms, tool calls
 *   - OTLP export to any OpenTelemetry-compatible backend (Dynatrace, Grafana, etc.)
 *
 * Usage in openclaw config:
 *   {
 *     "plugins": {
 *       "entries": {
 *         "openclaw-deep-observability": {
 *           "enabled": true,
 *           "config": {
 *             "endpoint": "http://localhost:4318",
 *             "protocol": "http",
 *             "serviceName": "openclaw-gateway",
 *             "traces": true,
 *             "metrics": true,
 *             "captureContent": false,
 *             "spanCache": false,
 *             "spanCacheVerboseLogs": false
 *           }
 *         }
 *       }
 *     }
 *   }
 */

import { parseConfig, type OtelObservabilityConfig } from "./src/config.js";
import { initTelemetry, type TelemetryRuntime } from "./src/telemetry.js";
import { initOpenLLMetry } from "./src/openllmetry.js";
import * as hooksModule from "./src/hooks.js";
import { registerDiagnosticsListener, hasDiagnosticsSupport } from "./src/diagnostics.js";
import { startSessionWatcher, stopSessionWatcher } from "./src/session-lifecycle.js";

const registerHooks =
  typeof hooksModule.registerHooks === "function"
    ? hooksModule.registerHooks
    : typeof hooksModule.default === "function"
      ? hooksModule.default
      : typeof (hooksModule.default as any)?.registerHooks === "function"
        ? (hooksModule.default as any).registerHooks
        : undefined;

let telemetry: TelemetryRuntime | null = null;
let unsubscribeDiagnostics: (() => void) | null = null;

const otelObservabilityPlugin = {
  id: "openclaw-deep-observability",
  name: "OpenClaw Deep Observability Plugin",
  description:
    "Connected traces, cost tracking, and metrics for OpenClaw via OpenTelemetry",

  configSchema: {
    parse(value: unknown): OtelObservabilityConfig {
      return parseConfig(value);
    },
  },

  async register(api: any) {
    const config = parseConfig(api.pluginConfig);
    const logger = api.logger;

    // ── RPC: status endpoint ────────────────────────────────────────

    api.registerGatewayMethod(
      "openclaw-deep-observability.status",
      ({ respond }: { respond: (ok: boolean, payload?: unknown) => void }) => {
        respond(true, {
          initialized: telemetry !== null,
          config: {
            endpoint: config.endpoint,
            protocol: config.protocol,
            serviceName: config.serviceName,
            traces: config.traces,
            metrics: config.metrics,
            logs: config.logs,
            captureContent: config.captureContent,
            spanCache: config.spanCache,
            spanCacheVerboseLogs: config.spanCacheVerboseLogs,
          },
        });
      }
    );

    // ── CLI command ─────────────────────────────────────────────────

    api.registerCli(
      ({ program }: { program: any }) => {
        program
          .command("otel")
          .description("OpenClaw Deep Observability Plugin status")
          .action(async () => {
            console.log("🔭 OpenClaw Deep Observability Plugin");
            console.log("─".repeat(40));
            console.log(`  Endpoint:        ${config.endpoint}`);
            console.log(`  Protocol:        ${config.protocol}`);
            console.log(`  Service:         ${config.serviceName}`);
            console.log(`  Traces:          ${config.traces ? "✅" : "❌"}`);
            console.log(`  Metrics:         ${config.metrics ? "✅" : "❌"}`);
            console.log(`  Logs:            ${config.logs ? "✅" : "❌"}`);
            console.log(`  Capture content: ${config.captureContent ? "✅" : "❌"}`);
            console.log(`  Span cache:      ${config.spanCache ? "✅" : "❌"}`);
            console.log(`  Cache verbose logs: ${config.spanCacheVerboseLogs ? "✅" : "❌"}`);
            console.log(`  Initialized:     ${telemetry ? "✅" : "❌"}`);
            console.log(`  Cost tracking:   ${hasDiagnosticsSupport() ? "✅ (via diagnostics API)" : "❌"}`);
            console.log(`  Agent handoff:   ✅ (span links)`);
            console.log(`  Fork/join:       ✅ (parallel tool detection)`);
            console.log(`  Session lifecycle: ✅ (session.start + session.end after 5m idle)`);
          });
      },
      { commands: ["otel"] }
    );


    if (typeof registerHooks !== "function") {
      throw new TypeError("hooks module did not provide a callable registerHooks export");
    }

    // Register hooks NOW (during register phase) so OpenClaw picks them up.
    // Telemetry is resolved lazily on first hook invocation (after service.start()).
    registerHooks(api, () => telemetry!, config);

    // ── Background service ──────────────────────────────────────────

    api.registerService({
      id: "openclaw-deep-observability",

      start: async () => {
        logger.info("[otel] Starting OpenTelemetry Observe PoC...");

        // 1. Initialize our OTel providers FIRST (traces + metrics)
        //    This registers our TracerProvider as global, so all spans
        //    (including GenAI wraps) export through our pipeline.
        if (!telemetry) {
          telemetry = initTelemetry(config, logger);
        }

        // 2. Wrap LLM SDKs AFTER provider is registered
        //    The wraps use trace.getTracer() which goes through our provider.
        if (config.traces) {
          await initOpenLLMetry(config, logger);
        }

        // Start session lifecycle watcher (session.start + idle-based session.end detection)
        startSessionWatcher(telemetry!.tracer, logger, undefined, {
          enableSpanCache: config.spanCache,
          spanCacheVerboseLogs: config.spanCacheVerboseLogs,
        });

        // Subscribe to OpenClaw diagnostic events (model.usage, etc.)
        // This gives us cost data and accurate token counts
        unsubscribeDiagnostics = await registerDiagnosticsListener(telemetry, logger);
        if (hasDiagnosticsSupport()) {
          logger.info("[otel] ✅ Integrated with OpenClaw diagnostics (cost tracking enabled)");
        }

        logger.info("[otel] ✅ Observe PoC pipeline active");
        logger.info(
          `[otel]   Traces=${config.traces} Metrics=${config.metrics} Logs=${config.logs}`
        );
        logger.info(`[otel]   Endpoint=${config.endpoint} (${config.protocol})`);
      },

      stop: async () => {
        if (unsubscribeDiagnostics) {
          unsubscribeDiagnostics();
          unsubscribeDiagnostics = null;
        }
        stopSessionWatcher();
        if (telemetry) {
          await telemetry.shutdown();
          telemetry = null;
          logger.info("[otel] Telemetry shut down");
        }
      },
    });

    // ── Agent tool: otel_status ─────────────────────────────────────
    // Lets the agent check Observe PoC status in conversation

    api.registerTool(
      {
        name: "otel_status",
        label: "OTel Status",
        description:
          "Check the OpenTelemetry observability plugin status and configuration.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute() {
          const status = {
            initialized: telemetry !== null,
            endpoint: config.endpoint,
            protocol: config.protocol,
            serviceName: config.serviceName,
            traces: config.traces,
            metrics: config.metrics,
            logs: config.logs,
            captureContent: config.captureContent,
            spanCache: config.spanCache,
            spanCacheVerboseLogs: config.spanCacheVerboseLogs,
          };
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(status, null, 2),
              },
            ],
          };
        },
      },
      { optional: true }
    );
  },
};

export default otelObservabilityPlugin;

// ── Span Cache public API ─────────────────────────────────────────
// Re-exported so callers (e.g., tests or metric-computation helpers)
// can query the cache without importing deep internals.
export {
  getByTrace,
  getBySession,
  getBySessionKey,
  getCacheStats,
  flushBySessionKey,
  stopSpanCache,
  type SpanRecord,
} from "./src/span-cache.js";
