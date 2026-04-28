/**
 * OpenClaw OTel GenAI Preload Script
 *
 * Usage:
 *   NODE_OPTIONS="--import /path/to/preload.mjs" openclaw gateway start
 *
 * CRITICAL: In Node 22+, ESM loader hooks must be registered via
 * register() from node:module. Simply importing hook.mjs doesn't work.
 */

import { register } from 'node:module';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Step 1: Register IITM as an ESM module loader hook
// This MUST happen before any instrumented modules are imported.
const require = createRequire(import.meta.url);
const iitmHookPath = require.resolve('import-in-the-middle/hook.mjs');
// Preload the IITM hook with an include filter for
// openai, anthropic-ai, @goolge (for vertex).
// Add other modules to the include filter as needed.
register(pathToFileURL(iitmHookPath).href, {
  parentURL: import.meta.url,
  data: { include: [/openai/, /@anthropic-ai/, /@google/] },
});

// Step 2: Set up the OTel SDK with GenAI instrumentations
const { NodeSDK } = await import("@opentelemetry/sdk-node");
const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");
const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-node");
const { resourceFromAttributes } = await import("@opentelemetry/resources");
const { AnthropicInstrumentation } = await import("@traceloop/instrumentation-anthropic");
const { BedrockInstrumentation } = await import("@traceloop/instrumentation-bedrock");
const { OpenAIInstrumentation } = await import("@traceloop/instrumentation-openai");
const { VertexAIInstrumentation } = await import("@traceloop/instrumentation-vertexai");
const { trace } = await import("@opentelemetry/api");
const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks");
const { AsyncLocalStorage } = await import("node:async_hooks");

/**
 * Per-async-chain store for the active agent OTel context.
 *
 * Why AsyncLocalStorage instead of a single global:
 *   When two agents run in parallel each occupies its own Promise chain.
 *   Using enterWith() in before_agent_start writes the agent context into
 *   the *current* async resource, so every continuation in that chain
 *   (including the auto-instrumented Anthropic/OpenAI call) inherits it
 *   independently from all other parallel agents.
 *   A single global variable would be overwritten by whichever agent starts
 *   last, causing all LLM spans to share the same parentSpanId.
 */
const agentContextFallbackStore = new AsyncLocalStorage();

/**
 * Expose the store so hooks.ts can call enterWith() / clear() on it
 * without importing from this ESM module.
 */
globalThis.__OPENCLAW_AGENT_CONTEXT_STORE = agentContextFallbackStore;

/**
 * Custom ContextManager that falls back to the per-chain agent context when
 * the async chain between a hook callback and the actual LLM call is broken
 * (e.g. OpenClaw dispatches hooks then calls Anthropic in a separate async
 * turn). This ensures auto-instrumented LLM spans (OpenLLMetry) are
 * correctly parented under the active agent span even for parallel agents.
 *
 * Priority:
 *   1. Normal OTel async-local context (active span present) → use as-is.
 *   2. Per-chain fallback via agentContextFallbackStore (set by enterWith in
 *      before_agent_start) → correct context for each parallel agent chain.
 *   3. Legacy single-global __OPENCLAW_ACTIVE_AGENT_CONTEXT → backward compat
 *      for runtimes that do not yet populate the store.
 */
class AgentAwareContextManager extends AsyncLocalStorageContextManager {
  active() {
    const ctx = super.active();
    if (!trace.getSpan(ctx)) {
      const chainContext = agentContextFallbackStore.getStore();
      if (chainContext) {
        return chainContext;
      }
      // Legacy fallback (single-agent or older plugin versions)
      if (globalThis.__OPENCLAW_ACTIVE_AGENT_CONTEXT) {
        return globalThis.__OPENCLAW_ACTIVE_AGENT_CONTEXT;
      }
    }
    return ctx;
  }
}

const providerInstrumentations = [
  new AnthropicInstrumentation({ traceContent: true }),
  new BedrockInstrumentation({ traceContent: true }),
  new OpenAIInstrumentation({ traceContent: true }),
  new VertexAIInstrumentation({ traceContent: true }),
];
const providerNames = ["anthropic", "bedrock", "openai", "vertexai"];

const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "openclaw-gateway";

const resource = resourceFromAttributes({
  "service.name": SERVICE_NAME,
  "service.version": "0.1.0",
  "telemetry.sdk.name": "openclaw-otel-preload",
});

const traceExporter = new OTLPTraceExporter({
  url: `${OTLP_ENDPOINT}/v1/traces`,
});

const sdk = new NodeSDK({
  resource,
  spanProcessors: [new BatchSpanProcessor(traceExporter)],
  instrumentations: providerInstrumentations,
  contextManager: new AgentAwareContextManager().enable(),
});

sdk.start();

// Signal to the plugin that preload is active
globalThis.__OPENCLAW_OTEL_PRELOAD_ACTIVE = true;

process.on("SIGTERM", () => sdk.shutdown());
process.on("SIGINT", () => sdk.shutdown());

console.log(
  `[otel-preload] GenAI instrumentation active (providers=${providerNames.join(",")}, endpoint=${OTLP_ENDPOINT}, IITM loader registered)`
);
