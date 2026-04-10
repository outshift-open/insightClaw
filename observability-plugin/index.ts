/**
 * OpenClaw OTel Observe PoC Plugin
 *
 * Provides full OpenTelemetry Observe PoC for OpenClaw:
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
 *         "otel-observe-poc": {
 *           "enabled": true,
 *           "config": {
 *             "endpoint": "http://localhost:4318",
 *             "protocol": "http",
 *             "serviceName": "openclaw-gateway",
 *             "traces": true,
 *             "metrics": true,
 *             "captureContent": false
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

const otelObservabilityPlugin = {
  id: "otel-observe-poc",
  name: "OpenTelemetry Observe PoC",
  description:
    "Connected traces, cost tracking, and metrics for OpenClaw via OpenTelemetry",

  configSchema: {
    parse(value: unknown): OtelObservabilityConfig {
      return parseConfig(value);
    },
  },

  register(api: any) {
    const config = parseConfig(api.pluginConfig);
    const logger = api.logger;

    let telemetry: TelemetryRuntime | null = null;
    let unsubscribeDiagnostics: (() => void) | null = null;

    // ── RPC: status endpoint ────────────────────────────────────────

    api.registerGatewayMethod(
      "otel-observe-poc.status",
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
          },
        });
      }
    );

    // ── CLI command ─────────────────────────────────────────────────

    api.registerCli(
      ({ program }: { program: any }) => {
        program
          .command("otel")
          .description("OpenTelemetry Observe PoC status")
          .action(async () => {
            console.log("🔭 OpenTelemetry Observe PoC Plugin");
            console.log("─".repeat(40));
            console.log(`  Endpoint:        ${config.endpoint}`);
            console.log(`  Protocol:        ${config.protocol}`);
            console.log(`  Service:         ${config.serviceName}`);
            console.log(`  Traces:          ${config.traces ? "✅" : "❌"}`);
            console.log(`  Metrics:         ${config.metrics ? "✅" : "❌"}`);
            console.log(`  Logs:            ${config.logs ? "✅" : "❌"}`);
            console.log(`  Capture content: ${config.captureContent ? "✅" : "❌"}`);
            console.log(`  Initialized:     ${telemetry ? "✅" : "❌"}`);
            console.log(`  Cost tracking:   ${hasDiagnosticsSupport() ? "✅ (via diagnostics API)" : "❌"}`);
            console.log(`  Agent handoff:   ✅ (span links)`);
            console.log(`  Fork/join:       ✅ (parallel tool detection)`);
            console.log(`  Session lifecycle: ✅ (auto session.end)`);
          });
      },
      { commands: ["otel"] }
    );

    // ── Background service ──────────────────────────────────────────

    api.registerService({
      id: "otel-observe-poc",

      start: async () => {
        logger.info("[otel] Starting OpenTelemetry Observe PoC...");

        // 1. Initialize our OTel providers FIRST (traces + metrics)
        //    This registers our TracerProvider as global, so all spans
        //    (including GenAI wraps) export through our pipeline.
        telemetry = initTelemetry(config, logger);

        // 2. Wrap LLM SDKs AFTER provider is registered
        //    The wraps use trace.getTracer() which goes through our provider.
        if (config.traces) {
          await initOpenLLMetry(config, logger);
        }

        // 3. Register hooks for tool results and command events
        if (typeof registerHooks !== "function") {
          throw new TypeError("hooks module did not provide a callable registerHooks export");
        }
        registerHooks(api, telemetry, config);

        // 4. Start session lifecycle watcher (auto session.end detection)
        startSessionWatcher(telemetry.tracer, logger);

        // 5. Subscribe to OpenClaw diagnostic events (model.usage, etc.)
        //    This gives us cost data and accurate token counts
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
