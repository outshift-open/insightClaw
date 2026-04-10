/**
 * Diagnostic events integration — subscribes to OpenClaw's internal diagnostic
 * events to get accurate cost/token data, then enriches our connected traces.
 *
 * This combines the best of both approaches:
 * - Our plugin: Connected traces (request → agent turn → tools)
 * - Official diagnostics: Accurate cost, token counts, context limits
 */

import { SpanKind, SpanStatusCode, context, trace, type Attributes, type Span } from "@opentelemetry/api";
import type { TelemetryRuntime } from "./telemetry.js";

// Import from OpenClaw plugin SDK (loaded lazily)
type DiagnosticEventSubscriber = (listener: (evt: any) => void) => () => void;

let onDiagnosticEvent: DiagnosticEventSubscriber | null = null;
let sdkLoadAttempted = false;

async function loadSdk(): Promise<void> {
  if (sdkLoadAttempted) return;
  sdkLoadAttempted = true;
  try {
    // Dynamic import to avoid build issues if SDK not available
    // @ts-ignore - openclaw/plugin-sdk types not available at build time
    const sdk = await import("openclaw/plugin-sdk") as any;
    onDiagnosticEvent = sdk.onDiagnosticEvent;
  } catch {
    // SDK not available — will use fallback token extraction
  }
}

/** Pending usage data waiting to be attached to spans */
interface PendingUsageData {
  costUsd?: number;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  context?: {
    limit?: number;
    used?: number;
  };
  durationMs?: number;
  provider?: string;
  model?: string;
}

function pushIdentity(target: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed || target.includes(trimmed)) return;
  target.push(trimmed);
}

function collectSessionIdentities(...sources: any[]): string[] {
  const identities: string[] = [];

  for (const source of sources) {
    pushIdentity(identities, source?.sessionKey);
    pushIdentity(identities, source?.sessionId);
    pushIdentity(identities, source?.conversationId);
  }

  return identities;
}

function deleteMapEntriesByValue<T>(map: Map<string, T>, value: T): void {
  for (const [key, current] of map.entries()) {
    if (current === value) {
      map.delete(key);
    }
  }
}

function setMapEntries<T>(map: Map<string, T>, keys: string[], value: T): void {
  for (const key of keys) {
    map.set(key, value);
  }
}

function findMapEntry<T>(map: Map<string, T>, keys: string[]): T | undefined {
  for (const key of keys) {
    const value = map.get(key);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) continue;
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function resolveDiagnosticSessionKey(evt: any): string {
  return resolveDiagnosticSessionIdentities(evt)[0] || "unknown";
}

function resolveDiagnosticSessionIdentities(evt: any): string[] {
  return collectSessionIdentities(evt, evt?.metadata, evt?.context, evt?.context?.metadata);
}

function normalizeUsageData(rawUsage: any): PendingUsageData["usage"] {
  const usage = rawUsage || {};
  const metadata = usage.usageMetadata || usage.metadata || {};
  const input = firstNumber(
    usage.input,
    usage.inputTokens,
    usage.input_tokens,
    usage.prompt,
    usage.promptTokens,
    usage.prompt_tokens,
    usage.promptTokenCount,
    metadata.input,
    metadata.inputTokens,
    metadata.input_tokens,
    metadata.prompt,
    metadata.promptTokens,
    metadata.prompt_tokens,
    metadata.promptTokenCount
  );
  const output = firstNumber(
    usage.output,
    usage.outputTokens,
    usage.output_tokens,
    usage.completion,
    usage.completionTokens,
    usage.completion_tokens,
    usage.candidatesTokenCount,
    usage.outputTokenCount,
    metadata.output,
    metadata.outputTokens,
    metadata.output_tokens,
    metadata.completion,
    metadata.completionTokens,
    metadata.completion_tokens,
    metadata.candidatesTokenCount,
    metadata.outputTokenCount
  );
  const cacheRead = firstNumber(
    usage.cacheRead,
    usage.cache_read,
    usage.cacheReadTokens,
    usage.cache_read_tokens,
    usage.cachedContentTokenCount,
    metadata.cacheRead,
    metadata.cache_read,
    metadata.cacheReadTokens,
    metadata.cache_read_tokens,
    metadata.cachedContentTokenCount
  );
  const cacheWrite = firstNumber(
    usage.cacheWrite,
    usage.cache_write,
    usage.cacheCreation,
    usage.cacheCreationInputTokens,
    usage.cache_creation_input_tokens,
    usage.cacheWriteTokens,
    usage.cache_write_tokens,
    metadata.cacheWrite,
    metadata.cache_write,
    metadata.cacheCreation,
    metadata.cacheCreationInputTokens,
    metadata.cache_creation_input_tokens,
    metadata.cacheWriteTokens,
    metadata.cache_write_tokens
  );
  const total = firstNumber(
    usage.total,
    usage.totalTokens,
    usage.total_tokens,
    usage.totalTokenCount,
    metadata.total,
    metadata.totalTokens,
    metadata.total_tokens,
    metadata.totalTokenCount,
    input !== undefined || output !== undefined || cacheRead !== undefined || cacheWrite !== undefined
      ? (input || 0) + (output || 0) + (cacheRead || 0) + (cacheWrite || 0)
      : undefined
  );

  return { input, output, cacheRead, cacheWrite, total };
}

function summarizeDiagnosticShape(evt: any): Record<string, unknown> {
  const usage = evt?.usage || {};
  const metadata = usage?.usageMetadata || usage?.metadata || {};

  return {
    topLevelKeys: Object.keys(evt || {}).sort(),
    usageKeys: Object.keys(usage).sort(),
    usageMetadataKeys: Object.keys(metadata).sort(),
    sessionCandidates: {
      sessionKey: evt?.sessionKey,
      sessionId: evt?.sessionId,
      conversationId: evt?.conversationId,
      metadataSessionId: evt?.metadata?.sessionId,
      contextSessionKey: evt?.context?.sessionKey,
      contextSessionId: evt?.context?.sessionId,
      contextConversationId: evt?.context?.conversationId,
    },
    modelCandidates: {
      model: evt?.model,
      modelName: evt?.modelName,
      provider: evt?.provider,
      vendor: evt?.vendor,
      system: evt?.system,
    },
    tokenCandidates: {
      usageInput: usage?.input,
      usageOutput: usage?.output,
      usageTotal: usage?.total,
      usageInputTokens: usage?.inputTokens,
      usageOutputTokens: usage?.outputTokens,
      usageTotalTokens: usage?.totalTokens,
      usagePromptTokenCount: usage?.promptTokenCount,
      usageCandidatesTokenCount: usage?.candidatesTokenCount,
      usageTotalTokenCount: usage?.totalTokenCount,
      metadataPromptTokenCount: metadata?.promptTokenCount,
      metadataCandidatesTokenCount: metadata?.candidatesTokenCount,
      metadataTotalTokenCount: metadata?.totalTokenCount,
    },
  };
}

/** Map of sessionKey → pending usage data from diagnostic events */
const pendingUsageMap = new Map<string, PendingUsageData>();

/** Map of sessionKey → active agent span (set by hooks.ts) */
export const activeAgentSpans = new Map<string, Span>();

export function registerActiveAgentSpan(sessionIdentities: string[], span: Span): void {
  setMapEntries(activeAgentSpans, sessionIdentities, span);
}

export function unregisterActiveAgentSpan(sessionIdentities: string[]): void {
  const span = findMapEntry(activeAgentSpans, sessionIdentities);
  if (span) {
    deleteMapEntriesByValue(activeAgentSpans, span);
    return;
  }

  for (const sessionIdentity of sessionIdentities) {
    activeAgentSpans.delete(sessionIdentity);
  }
}

function startDiagnosticSpan(
  telemetry: TelemetryRuntime,
  name: string,
  attributes: Attributes,
  options?: {
    durationMs?: number;
    parentSpan?: Span;
    errorMessage?: string;
  }
): void {
  const span = telemetry.tracer.startSpan(
    name,
    {
      kind: SpanKind.INTERNAL,
      attributes,
      ...(typeof options?.durationMs === "number"
        ? { startTime: Date.now() - Math.max(0, options.durationMs) }
        : {}),
    },
    options?.parentSpan ? trace.setSpan(context.active(), options.parentSpan) : context.active()
  );

  if (options?.errorMessage) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: options.errorMessage });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
}

export function setOnDiagnosticEventForTest(subscriber: DiagnosticEventSubscriber | null): void {
  onDiagnosticEvent = subscriber;
  sdkLoadAttempted = subscriber !== null;
}

/**
 * Register diagnostic event listener to capture model.usage events.
 * Returns unsubscribe function.
 */
export async function registerDiagnosticsListener(
  telemetry: TelemetryRuntime,
  logger: any
): Promise<() => void> {
  // Load the SDK if not already loaded
  await loadSdk();

  if (!onDiagnosticEvent) {
    logger.debug("[otel] onDiagnosticEvent not available — using fallback token extraction");
    return () => {};
  }

  const { counters, histograms } = telemetry;
  const costCounter = telemetry.meter.createCounter("openclaw.cost.usd", {
    description: "Estimated model cost in USD from diagnostic events",
    unit: "usd",
  });
  const webhookReceivedCounter = telemetry.meter.createCounter("openclaw.webhook.received", {
    description: "Diagnostic webhook ingress events",
    unit: "events",
  });
  const webhookErrorCounter = telemetry.meter.createCounter("openclaw.webhook.error", {
    description: "Diagnostic webhook error events",
    unit: "errors",
  });
  const webhookDurationHistogram = telemetry.meter.createHistogram("openclaw.webhook.duration_ms", {
    description: "Webhook processing duration from diagnostic events",
    unit: "ms",
  });
  const messageQueuedCounter = telemetry.meter.createCounter("openclaw.message.queued", {
    description: "Diagnostic message queued events",
    unit: "events",
  });
  const messageProcessedCounter = telemetry.meter.createCounter("openclaw.message.processed", {
    description: "Diagnostic message processed events",
    unit: "events",
  });
  const messageDurationHistogram = telemetry.meter.createHistogram("openclaw.message.duration_ms", {
    description: "Diagnostic message processing duration",
    unit: "ms",
  });
  const queueDepthHistogram = telemetry.meter.createHistogram("openclaw.queue.depth", {
    description: "Queue depth reported by diagnostic events",
    unit: "items",
  });
  const queueWaitHistogram = telemetry.meter.createHistogram("openclaw.queue.wait_ms", {
    description: "Queue wait time reported by diagnostic events",
    unit: "ms",
  });
  const laneEnqueueCounter = telemetry.meter.createCounter("openclaw.queue.lane.enqueue", {
    description: "Diagnostic lane enqueue events",
    unit: "events",
  });
  const laneDequeueCounter = telemetry.meter.createCounter("openclaw.queue.lane.dequeue", {
    description: "Diagnostic lane dequeue events",
    unit: "events",
  });
  const sessionStateCounter = telemetry.meter.createCounter("openclaw.session.state", {
    description: "Diagnostic session state transitions",
    unit: "events",
  });
  const sessionStuckCounter = telemetry.meter.createCounter("openclaw.session.stuck", {
    description: "Diagnostic stuck-session events",
    unit: "events",
  });
  const sessionStuckAgeHistogram = telemetry.meter.createHistogram("openclaw.session.stuck_age_ms", {
    description: "Age of stuck sessions from diagnostic events",
    unit: "ms",
  });
  const runAttemptCounter = telemetry.meter.createCounter("openclaw.run.attempt", {
    description: "Diagnostic run attempt count",
    unit: "attempts",
  });
  const toolLoopCounter = telemetry.meter.createCounter("openclaw.tool.loop", {
    description: "Diagnostic tool loop warnings and blocks",
    unit: "events",
  });

  function addSessionIdentityAttrs(attrs: Record<string, string | number>, evt: any): void {
    const sessionKey = firstString(evt?.sessionKey, evt?.metadata?.sessionKey, evt?.context?.sessionKey);
    const sessionId = firstString(evt?.sessionId, evt?.metadata?.sessionId, evt?.context?.sessionId);

    if (sessionKey) {
      attrs["openclaw.session.key"] = sessionKey;
    }
    if (sessionId) {
      attrs["openclaw.session.id"] = sessionId;
    }
  }

  function resolveActiveAgentSpan(evt: any): Span | undefined {
    return findMapEntry(activeAgentSpans, resolveDiagnosticSessionIdentities(evt));
  }

  const unsubscribe = onDiagnosticEvent((evt: any) => {
    switch (evt.type) {
      case "model.usage": {
        const sessionIdentities = resolveDiagnosticSessionIdentities(evt);
        const sessionKey = sessionIdentities[0] || "unknown";
        const usage = normalizeUsageData(evt.usage);
        const costUsd = evt.costUsd;
        const channel = firstString(evt.channel) || "unknown";
        const model = firstString(evt.model, evt.modelName) || "unknown";
        const provider = firstString(evt.provider, evt.vendor, evt.system) || "unknown";
        const pendingUsage: PendingUsageData = {
          costUsd,
          usage,
          context: evt.context,
          durationMs: evt.durationMs,
          provider,
          model,
        };

        setMapEntries(pendingUsageMap, sessionIdentities, pendingUsage);

        const metricAttrs = {
          "gen_ai.response.model": model,
          "openclaw.provider": provider,
          "openclaw.channel": channel,
        };

        if (usage.input !== undefined) {
          counters.tokensPrompt.add(usage.input, metricAttrs);
        }
        if (usage.output !== undefined) {
          counters.tokensCompletion.add(usage.output, metricAttrs);
        }
        if (usage.cacheRead !== undefined) {
          counters.tokensPrompt.add(usage.cacheRead, { ...metricAttrs, "token.type": "cache_read" });
        }
        if (usage.cacheWrite !== undefined) {
          counters.tokensPrompt.add(usage.cacheWrite, { ...metricAttrs, "token.type": "cache_write" });
        }
        if (usage.total !== undefined) {
          counters.tokensTotal.add(usage.total, metricAttrs);
        }

        if (model !== "unknown" && usage.input === undefined && usage.output === undefined && usage.total === undefined) {
          logger.debug(`[otel] model.usage unresolved token shape: ${JSON.stringify(summarizeDiagnosticShape(evt))}`);
        }

        if (typeof costUsd === "number" && costUsd > 0) {
          costCounter.add(costUsd, metricAttrs);
        }
        if (typeof evt.durationMs === "number") {
          histograms.llmDuration.record(evt.durationMs, metricAttrs);
        }
        counters.llmRequests.add(1, metricAttrs);

        const agentSpan = resolveActiveAgentSpan(evt);
        if (agentSpan) {
          enrichSpanWithUsage(agentSpan, pendingUsage);
          deleteMapEntriesByValue(pendingUsageMap, pendingUsage);
        }

        const spanAttrs: Record<string, string | number> = {
          "openclaw.channel": channel,
          "openclaw.provider": provider,
          "openclaw.model": model,
          "openclaw.tokens.input": usage.input ?? 0,
          "openclaw.tokens.output": usage.output ?? 0,
          "openclaw.tokens.cache_read": usage.cacheRead ?? 0,
          "openclaw.tokens.cache_write": usage.cacheWrite ?? 0,
          "openclaw.tokens.total": usage.total ?? 0,
        };
        addSessionIdentityAttrs(spanAttrs, evt);
        startDiagnosticSpan(telemetry, "openclaw.model.usage", spanAttrs, {
          durationMs: evt.durationMs,
          parentSpan: agentSpan,
        });

        logger.debug(`[otel] model.usage: session=${sessionKey}, model=${model}, cost=$${costUsd?.toFixed(4) || "?"}, tokens=${usage.total || "?"}`);
        return;
      }

      case "webhook.received": {
        webhookReceivedCounter.add(1, {
          "openclaw.channel": firstString(evt.channel) || "unknown",
          "openclaw.webhook": firstString(evt.updateType) || "unknown",
        });
        return;
      }

      case "webhook.processed": {
        const attrs = {
          "openclaw.channel": firstString(evt.channel) || "unknown",
          "openclaw.webhook": firstString(evt.updateType) || "unknown",
        };
        if (typeof evt.durationMs === "number") {
          webhookDurationHistogram.record(evt.durationMs, attrs);
        }
        const spanAttrs: Record<string, string | number> = { ...attrs };
        if (evt.chatId !== undefined) {
          spanAttrs["openclaw.chat_id"] = String(evt.chatId);
        }
        startDiagnosticSpan(telemetry, "openclaw.webhook.processed", spanAttrs, {
          durationMs: evt.durationMs,
        });
        return;
      }

      case "webhook.error": {
        const attrs = {
          "openclaw.channel": firstString(evt.channel) || "unknown",
          "openclaw.webhook": firstString(evt.updateType) || "unknown",
        };
        webhookErrorCounter.add(1, attrs);
        const errorMessage = firstString(evt.error) || "webhook error";
        const spanAttrs: Record<string, string | number> = {
          ...attrs,
          "openclaw.error": errorMessage,
        };
        if (evt.chatId !== undefined) {
          spanAttrs["openclaw.chat_id"] = String(evt.chatId);
        }
        startDiagnosticSpan(telemetry, "openclaw.webhook.error", spanAttrs, {
          errorMessage,
        });
        return;
      }

      case "message.queued": {
        const attrs = {
          "openclaw.channel": firstString(evt.channel) || "unknown",
          "openclaw.source": firstString(evt.source) || "unknown",
        };
        messageQueuedCounter.add(1, attrs);
        if (typeof evt.queueDepth === "number") {
          queueDepthHistogram.record(evt.queueDepth, attrs);
        }
        return;
      }

      case "message.processed": {
        const attrs = {
          "openclaw.channel": firstString(evt.channel) || "unknown",
          "openclaw.outcome": firstString(evt.outcome) || "unknown",
        };
        messageProcessedCounter.add(1, attrs);
        if (typeof evt.durationMs === "number") {
          messageDurationHistogram.record(evt.durationMs, attrs);
        }
        const spanAttrs: Record<string, string | number> = { ...attrs };
        addSessionIdentityAttrs(spanAttrs, evt);
        if (evt.chatId !== undefined) {
          spanAttrs["openclaw.chat_id"] = String(evt.chatId);
        }
        if (evt.messageId !== undefined) {
          spanAttrs["openclaw.message_id"] = String(evt.messageId);
        }
        if (evt.reason) {
          spanAttrs["openclaw.reason"] = String(evt.reason);
        }
        startDiagnosticSpan(telemetry, "openclaw.message.processed", spanAttrs, {
          durationMs: evt.durationMs,
          errorMessage: evt.outcome === "error"
            ? firstString(evt.error, evt.reason) || "message processing error"
            : undefined,
        });
        return;
      }

      case "queue.lane.enqueue": {
        const attrs = { "openclaw.lane": firstString(evt.lane) || "unknown" };
        laneEnqueueCounter.add(1, attrs);
        if (typeof evt.queueSize === "number") {
          queueDepthHistogram.record(evt.queueSize, attrs);
        }
        return;
      }

      case "queue.lane.dequeue": {
        const attrs = { "openclaw.lane": firstString(evt.lane) || "unknown" };
        laneDequeueCounter.add(1, attrs);
        if (typeof evt.queueSize === "number") {
          queueDepthHistogram.record(evt.queueSize, attrs);
        }
        if (typeof evt.waitMs === "number") {
          queueWaitHistogram.record(evt.waitMs, attrs);
        }
        return;
      }

      case "session.state": {
        const attrs: Record<string, string> = {
          "openclaw.state": firstString(evt.state) || "unknown",
        };
        if (evt.reason) {
          attrs["openclaw.reason"] = String(evt.reason);
        }
        sessionStateCounter.add(1, attrs);
        return;
      }

      case "session.stuck": {
        const attrs: Record<string, string> = {
          "openclaw.state": firstString(evt.state) || "unknown",
        };
        sessionStuckCounter.add(1, attrs);
        if (typeof evt.ageMs === "number") {
          sessionStuckAgeHistogram.record(evt.ageMs, attrs);
        }
        const spanAttrs: Record<string, string | number> = {
          ...attrs,
          "openclaw.age_ms": typeof evt.ageMs === "number" ? evt.ageMs : 0,
          "openclaw.queue_depth": typeof evt.queueDepth === "number" ? evt.queueDepth : 0,
        };
        addSessionIdentityAttrs(spanAttrs, evt);
        startDiagnosticSpan(telemetry, "openclaw.session.stuck", spanAttrs, {
          errorMessage: "session stuck",
        });
        return;
      }

      case "run.attempt": {
        runAttemptCounter.add(1, {
          "openclaw.attempt": typeof evt.attempt === "number" ? evt.attempt : 0,
        });
        return;
      }

      case "diagnostic.heartbeat": {
        queueDepthHistogram.record(typeof evt.queued === "number" ? evt.queued : 0, {
          "openclaw.channel": "heartbeat",
          "openclaw.metric": "queued",
        });
        queueDepthHistogram.record(typeof evt.active === "number" ? evt.active : 0, {
          "openclaw.channel": "heartbeat",
          "openclaw.metric": "active",
        });
        queueDepthHistogram.record(typeof evt.waiting === "number" ? evt.waiting : 0, {
          "openclaw.channel": "heartbeat",
          "openclaw.metric": "waiting",
        });
        return;
      }

      case "tool.loop": {
        const attrs = {
          "openclaw.tool": firstString(evt.toolName) || "unknown",
          "openclaw.detector": firstString(evt.detector) || "unknown",
          "openclaw.action": firstString(evt.action) || "unknown",
          "openclaw.level": firstString(evt.level) || "unknown",
        };
        toolLoopCounter.add(1, attrs);
        const spanAttrs: Record<string, string | number> = {
          ...attrs,
          "openclaw.count": typeof evt.count === "number" ? evt.count : 0,
          "openclaw.message": firstString(evt.message) || "tool loop detected",
        };
        addSessionIdentityAttrs(spanAttrs, evt);
        if (evt.pairedToolName) {
          spanAttrs["openclaw.paired_tool"] = String(evt.pairedToolName);
        }
        startDiagnosticSpan(telemetry, "openclaw.tool.loop", spanAttrs, {
          parentSpan: resolveActiveAgentSpan(evt),
          errorMessage: evt.level === "critical"
            ? firstString(evt.message) || "tool loop blocked"
            : undefined,
        });
        return;
      }
    }
  });

  logger.info("[otel] Subscribed to OpenClaw diagnostic events (model.usage, etc.)");
  return unsubscribe;
}

/**
 * Get pending usage data for a session (if any).
 * Called by agent_end hook to attach data to span.
 */
export function getPendingUsage(sessionIdentities: string | string[]): PendingUsageData | undefined {
  const identities = Array.isArray(sessionIdentities) ? sessionIdentities : [sessionIdentities];
  const data = findMapEntry(pendingUsageMap, identities);
  if (data) {
    deleteMapEntriesByValue(pendingUsageMap, data);
  }
  return data;
}

/**
 * Enrich a span with usage data from diagnostic event.
 */
export function enrichSpanWithUsage(span: Span, data: PendingUsageData): void {
  const usage = data.usage || {};

  // GenAI semantic convention attributes
  if (usage.input !== undefined) {
    span.setAttribute("gen_ai.usage.input_tokens", usage.input);
  }
  if (usage.output !== undefined) {
    span.setAttribute("gen_ai.usage.output_tokens", usage.output);
  }
  if (usage.total !== undefined) {
    span.setAttribute("gen_ai.usage.total_tokens", usage.total);
  }
  if (usage.cacheRead !== undefined) {
    span.setAttribute("gen_ai.usage.cache_read_tokens", usage.cacheRead);
  }
  if (usage.cacheWrite !== undefined) {
    span.setAttribute("gen_ai.usage.cache_write_tokens", usage.cacheWrite);
  }

  // Cost (custom attribute — not in GenAI semconv yet)
  if (data.costUsd !== undefined) {
    span.setAttribute("openclaw.llm.cost_usd", data.costUsd);
  }

  // Context window
  if (data.context?.limit !== undefined) {
    span.setAttribute("openclaw.context.limit", data.context.limit);
  }
  if (data.context?.used !== undefined) {
    span.setAttribute("openclaw.context.used", data.context.used);
  }

  // Provider/model
  if (data.provider) {
    span.setAttribute("gen_ai.system", data.provider);
  }
  if (data.model) {
    span.setAttribute("gen_ai.response.model", data.model);
  }
}

/**
 * Check if diagnostic events are available.
 * Note: Only accurate after registerDiagnosticsListener() has been called.
 */
export function hasDiagnosticsSupport(): boolean {
  return onDiagnosticEvent !== null;
}

/**
 * Async check for diagnostics support (loads SDK if needed).
 */
export async function checkDiagnosticsSupport(): Promise<boolean> {
  await loadSdk();
  return onDiagnosticEvent !== null;
}
