/**
 * OpenClaw event hooks - captures tool executions, agent turns, messages,
 * and gateway lifecycle as connected OTel traces.
 *
 * Trace structure per request:
 *   openclaw.request (root span, covers full message -> reply lifecycle)
 *   |- openclaw.agent.turn (agent processing span)
 *   |  |- tool.exec (tool call)          <- fork/join detected here
 *   |  |- tool.Read (tool call)
 *   |  |- anthropic.chat (auto-instrumented by OpenLLMetry)
 *   |  `- tool.write (tool call)
 *   `- (future: message.sent span)
 *
 * Context propagation:
 *   - message_received: creates root span, stores in sessionContextMap
 *   - before_agent_start: creates child "agent turn" span under root
 *     + agent handoff tracking via span links
 *     + join detection from previous parallel fork
 *   - tool_result_persist: creates child tool span under agent turn
 *     + fork detection for parallel tool calls
 *   - agent_end: ends the agent turn span
 *     + finalizes fork groups, annotates join metadata
 *
 * IMPORTANT: OpenClaw has TWO hook registration systems:
 *   - api.registerHook() -> event-stream hooks (command:new, gateway:startup)
 *   - api.on()           -> typed plugin hooks (tool_result_persist, agent_end)
 */

import { SpanKind, SpanStatusCode, context, trace, type Span, type SpanContext, type Context, type Link } from "@opentelemetry/api";
import type { TelemetryRuntime } from "./telemetry.js";
import type { OtelObservabilityConfig } from "./config.js";
import { getPendingUsage, registerActiveAgentSpan, unregisterActiveAgentSpan } from "./diagnostics.js";
import { checkToolSecurity, checkMessageSecurity, type SecurityCounters } from "./security.js";
import { onAgentStart, onAgentEnd, cleanupHandoff, getHandoffSequence, registerAgentSpan, seedHandoffState, setHandoffLogger } from "./handoff.js";
import { registerToolSpan, finalizeAgentTurn, consumeJoin, cleanupForkJoin, setForkJoinLogger } from "./forkjoin.js";
import {
  ObserveSpanKind,
  ATTR_OBSERVE_SPAN_KIND,
  ATTR_OBSERVE_ENTITY_NAME,
  ATTR_OBSERVE_ENTITY_INPUT,
  ATTR_OBSERVE_ENTITY_OUTPUT,
} from "./observe-attributes.js";
import { touchSession, endSession } from "./session-lifecycle.js";

/** Active trace context for a session - allows connecting spans into one trace. */
interface SessionTraceContext {
  sessionKey: string;
  rootSpan: Span;
  rootContext: Context;
  agentSpan?: Span;
  agentContext?: Context;
  latestInput?: string;
  startTime: number;
}

interface PendingSpawnHandoff {
  targetAgentId: string;
  sourceSessionKey: string;
  sourceAgentId: string;
  sourceAgentSequence: number;
  sourceAgentSpanContext?: SpanContext;
  spawnToolSpanContext: SpanContext;
  parentContext: Context;
  createdAt: number;
}

interface RootSpanSeed {
  parentContext?: Context;
  links?: Link[];
  attributes?: Record<string, string | number | boolean>;
}

/** Map of sessionKey -> active trace context. Cleaned up on agent_end. */
const sessionContextMap = new Map<string, SessionTraceContext>();
const pendingSpawnHandoffs = new Map<string, PendingSpawnHandoff[]>();
const PENDING_SPAWN_TTL_MS = 60_000;
const MAX_CAPTURE_CONTENT_CHARS = 4_096;

function pushCandidate(target: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed || target.includes(trimmed)) return;
  target.push(trimmed);
}

function parseAgentIdFromSessionLike(value: string): string | undefined {
  const match = /^agent:([^:]+):/.exec(value.trim());
  return match?.[1];
}

function collectSpawnTargetAgentIds(target: string[], value: unknown, depth = 0): void {
  if (depth > 4 || value == null) {
    return;
  }

  if (typeof value === "string") {
    pushCandidate(target, parseAgentIdFromSessionLike(value));

    const sessionMatches = value.matchAll(/agent:([^:\s]+):(main|subagent:[A-Za-z0-9-]+)/g);
    for (const match of sessionMatches) {
      pushCandidate(target, match[1]);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSpawnTargetAgentIds(target, entry, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase();
    if (typeof entry === "string") {
      if (
        normalizedKey === "agentid" ||
        normalizedKey === "targetagentid" ||
        normalizedKey === "targetagent" ||
        normalizedKey === "agent"
      ) {
        pushCandidate(target, entry);
      }

      if (normalizedKey === "sessionkey" || normalizedKey === "conversationid") {
        pushCandidate(target, parseAgentIdFromSessionLike(entry));
      }
    }

    collectSpawnTargetAgentIds(target, entry, depth + 1);
  }
}

function extractMessageTextParts(message: any): string[] {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .map((part: any) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      return "";
    })
    .filter((part: string) => part.length > 0);
}

function extractSpawnTargetAgentIds(input: unknown, message: unknown): string[] {
  const targetAgentIds: string[] = [];

  collectSpawnTargetAgentIds(targetAgentIds, input);
  collectSpawnTargetAgentIds(targetAgentIds, message);

  for (const text of extractMessageTextParts(message)) {
    collectSpawnTargetAgentIds(targetAgentIds, text);
    try {
      collectSpawnTargetAgentIds(targetAgentIds, JSON.parse(text));
    } catch {
      // Ignore non-JSON content.
    }
  }

  return targetAgentIds;
}

function queuePendingSpawnHandoff(handoff: PendingSpawnHandoff): void {
  const existing = pendingSpawnHandoffs.get(handoff.targetAgentId) ?? [];
  existing.push(handoff);
  pendingSpawnHandoffs.set(handoff.targetAgentId, existing);
}

function consumePendingSpawnHandoff(agentId: string): PendingSpawnHandoff | undefined {
  const existing = pendingSpawnHandoffs.get(agentId);
  if (!existing || existing.length === 0) {
    return undefined;
  }

  const cutoff = Date.now() - PENDING_SPAWN_TTL_MS;
  const fresh = existing.filter((entry) => entry.createdAt >= cutoff);
  pendingSpawnHandoffs.delete(agentId);

  if (fresh.length === 0) {
    return undefined;
  }

  const [next, ...remaining] = fresh;
  if (remaining.length > 0) {
    pendingSpawnHandoffs.set(agentId, remaining);
  }
  return next;
}

function resolveSessionKey(event?: any, ctx?: any): string {
  return resolveSessionIdentities(event, ctx)[0] || "unknown";
}

function resolveSessionIdentities(event?: any, ctx?: any): string[] {
  const keys: string[] = [];
  const metadata = event?.metadata;
  const ctxMetadata = ctx?.metadata;

  pushCandidate(keys, event?.sessionKey);
  pushCandidate(keys, ctx?.sessionKey);
  pushCandidate(keys, event?.sessionId);
  pushCandidate(keys, ctx?.sessionId);
  pushCandidate(keys, event?.conversationId);
  pushCandidate(keys, ctx?.conversationId);
  pushCandidate(keys, metadata?.sessionKey);
  pushCandidate(keys, metadata?.sessionId);
  pushCandidate(keys, metadata?.conversationId);
  pushCandidate(keys, ctxMetadata?.sessionKey);
  pushCandidate(keys, ctxMetadata?.sessionId);
  pushCandidate(keys, ctxMetadata?.conversationId);

  return keys;
}

function getSessionTraceContext(event?: any, ctx?: any): SessionTraceContext | undefined {
  for (const sessionIdentity of resolveSessionIdentities(event, ctx)) {
    const sessionCtx = sessionContextMap.get(sessionIdentity);
    if (sessionCtx) {
      return sessionCtx;
    }
  }

  return undefined;
}

function setSessionTraceContext(sessionCtx: SessionTraceContext, event?: any, ctx?: any): void {
  const sessionIdentities = resolveSessionIdentities(event, ctx);

  if (sessionIdentities.length === 0) {
    sessionContextMap.set(sessionCtx.sessionKey, sessionCtx);
    return;
  }

  for (const sessionIdentity of sessionIdentities) {
    sessionContextMap.set(sessionIdentity, sessionCtx);
  }
}

function deleteSessionTraceContext(sessionCtx: SessionTraceContext | undefined): void {
  if (!sessionCtx) {
    return;
  }

  for (const [sessionIdentity, activeSessionCtx] of sessionContextMap.entries()) {
    if (activeSessionCtx === sessionCtx) {
      sessionContextMap.delete(sessionIdentity);
    }
  }
}

function extractMessageText(event: any): string {
  if (typeof event?.text === "string") return event.text;
  if (typeof event?.message === "string") return event.message;
  if (typeof event?.content === "string") return event.content;

  if (Array.isArray(event?.content)) {
    return event.content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function truncateCapturedContent(value: string): string {
  return value.slice(0, MAX_CAPTURE_CONTENT_CHARS);
}

function serializeCapturedContent(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? truncateCapturedContent(trimmed) : undefined;
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized ? truncateCapturedContent(serialized) : undefined;
  } catch {
    const fallback = String(value).trim();
    return fallback ? truncateCapturedContent(fallback) : undefined;
  }
}

function setCapturedContent(
  span: Span,
  direction: "input" | "output",
  value: unknown,
  attrPrefixes: string[] = []
): string | undefined {
  const serialized = serializeCapturedContent(value);
  if (!serialized) {
    return undefined;
  }

  const observeAttr =
    direction === "input" ? ATTR_OBSERVE_ENTITY_INPUT : ATTR_OBSERVE_ENTITY_OUTPUT;
  span.setAttribute(observeAttr, serialized);
  span.setAttribute(`openclaw.entity.${direction}`, serialized);
  for (const prefix of attrPrefixes) {
    span.setAttribute(`${prefix}.${direction}`, serialized);
  }

  return serialized;
}

function extractLatestAssistantOutput(messages: any[]): unknown {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }

    const text = extractMessageText(message);
    if (text) {
      return text;
    }

    if (message?.content != null) {
      return message.content;
    }

    if (message?.message != null) {
      return message.message;
    }
  }

  return undefined;
}

function extractToolOutputPayload(event: any, message: any): unknown {
  const textParts = extractMessageTextParts(message);
  if (textParts.length > 0) {
    return textParts.join("");
  }

  const candidates = [
    message?.content,
    message?.result,
    message?.data,
    event?.output,
    event?.result,
    event?.data,
    message,
  ];

  for (const candidate of candidates) {
    if (candidate == null) {
      continue;
    }

    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed) {
        return trimmed;
      }
      continue;
    }

    if (Array.isArray(candidate) && candidate.length === 0) {
      continue;
    }

    if (typeof candidate === "object" && Object.keys(candidate).length === 0) {
      continue;
    }

    return candidate;
  }

  return undefined;
}

function resolveMessageFrom(event?: any, ctx?: any): string {
  const metadata = event?.metadata;
  const candidates = [
    event?.from,
    event?.senderId,
    metadata?.from,
    metadata?.senderId,
    metadata?.userId,
    metadata?.accountId,
    ctx?.accountId,
    ctx?.userId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }

  return "unknown";
}

function startRootSpan(
  tracer: any,
  event: any,
  ctx: any,
  config: OtelObservabilityConfig,
  logger: any,
  securityCounters: SecurityCounters,
  counters: any,
  seed?: RootSpanSeed
) {
  const sessionIdentities = resolveSessionIdentities(event, ctx);
  const primarySessionKey = sessionIdentities[0] || "unknown";

  if (primarySessionKey === "unknown") {
    logger.debug("[otel] Skipping eager request span start because no stable session/conversation key is available yet");
    return undefined;
  }

  const channel = event?.channel || ctx?.channelId || event?.metadata?.channelId || "unknown";
  const from = resolveMessageFrom(event, ctx);
  const messageText = extractMessageText(event);

  const parentContext = seed?.parentContext || context.active();
  const rootSpan = tracer.startSpan(
    "openclaw.request",
    {
      kind: SpanKind.SERVER,
      attributes: {
        [ATTR_OBSERVE_SPAN_KIND]: ObserveSpanKind.WORKFLOW,
        [ATTR_OBSERVE_ENTITY_NAME]: "openclaw.request",
        "openclaw.message.channel": channel,
        "openclaw.session.key": primarySessionKey,
        "openclaw.message.direction": "inbound",
        "openclaw.message.from": from,
        ...seed?.attributes,
      },
      links: seed?.links,
    },
    parentContext
  );

  if (messageText.length > 0) {
    const securityEvent = checkMessageSecurity(
      messageText,
      rootSpan,
      securityCounters,
      primarySessionKey
    );
    if (securityEvent) {
      logger.warn(`[otel] SECURITY: ${securityEvent.detection} - ${securityEvent.description}`);
    }
  }

  const rootContext = trace.setSpan(parentContext, rootSpan);
  const capturedInput = config.captureContent
    ? setCapturedContent(rootSpan, "input", messageText, ["openclaw.request"])
    : undefined;
  const sessionCtx: SessionTraceContext = {
    sessionKey: primarySessionKey,
    rootSpan,
    rootContext,
    latestInput: capturedInput,
    startTime: Date.now(),
  };

  setSessionTraceContext(sessionCtx, event, ctx);
  touchSession(primarySessionKey, rootContext);

  counters.messagesReceived.add(1, {
    "openclaw.message.channel": channel,
  });

  logger.info(`[otel] Root span started for session=${primarySessionKey}, channel=${channel}`);
  return sessionCtx;
}

/**
 * Register all plugin hooks on the OpenClaw plugin API.
 */
export function registerHooks(
  api: any,
  telemetry: TelemetryRuntime,
  config: OtelObservabilityConfig
): void {
  const { tracer, counters, histograms } = telemetry;
  const logger = api.logger;
  // Initialize loggers for sub-modules
  setHandoffLogger(logger);
  setForkJoinLogger(logger);
  // ==================================================================
  // TYPED HOOKS - registered via api.on() into registry.typedHooks
  // ==================================================================

  // -- message_received ------------------------------------------------
  // Creates the ROOT span for the entire request lifecycle.
  // All subsequent spans (agent, tools) become children of this span.

  // Build security counters object for detection module
  const securityCounters: SecurityCounters = {
    securityEvents: counters.securityEvents,
    sensitiveFileAccess: counters.sensitiveFileAccess,
    promptInjection: counters.promptInjection,
    dangerousCommand: counters.dangerousCommand,
  };

  // Spans created in before_tool_call, completed in tool_result_persist
  const pendingToolSpans = new Map<string, Span>();

  api.on(
    "message_received",
    async (event: any, ctx: any) => {
      try {
        const sessionKey = resolveSessionKey(event, ctx);
        const sessionCtx = getSessionTraceContext(event, ctx);
        if (sessionCtx) {
          setSessionTraceContext(sessionCtx, event, ctx);
          if (sessionKey !== "unknown") {
            touchSession(sessionKey, sessionCtx.rootContext);
          }

          const messageText = extractMessageText(event);
          if (config.captureContent) {
            sessionCtx.latestInput = setCapturedContent(
              sessionCtx.rootSpan,
              "input",
              messageText,
              ["openclaw.request"]
            ) ?? sessionCtx.latestInput;
          }
        } else {
          startRootSpan(tracer, event, ctx, config, logger, securityCounters, counters);
        }
      } catch (error) {
        logger.debug(`[otel] message_received hook failed: ${String(error)}`);
        // Never let telemetry errors break the main flow
      }
    },
    { priority: 100 } // High priority - run first to establish context
  );

  logger.info("[otel] Registered message_received hook (via api.on)");

  api.on(
    "message_sent",
    async (event: any, ctx: any) => {
      try {
        const sessionKey = resolveSessionKey(event, ctx);
        const sessionCtx = getSessionTraceContext(event, ctx);
        const parentContext = sessionCtx?.rootContext || context.active();
        const channel = event?.channel || ctx?.channelId || event?.metadata?.channelId || "unknown";
        const messageText = extractMessageText(event);

        const span = tracer.startSpan(
          "openclaw.message.sent",
          {
            kind: SpanKind.PRODUCER,
            attributes: {
              [ATTR_OBSERVE_SPAN_KIND]: ObserveSpanKind.WORKFLOW,
              [ATTR_OBSERVE_ENTITY_NAME]: "openclaw.message.sent",
              "openclaw.message.channel": channel,
              "openclaw.message.direction": "outbound",
              "openclaw.session.key": sessionKey,
            },
          },
          parentContext
        );

        if (config.captureContent) {
          setCapturedContent(span, "output", messageText, ["openclaw.message"]);
        }

        counters.messagesSent.add(1, {
          "openclaw.message.channel": channel,
        });

        if (sessionKey !== "unknown") {
          touchSession(sessionKey, parentContext);
        }

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch (error) {
        logger.debug(`[otel] message_sent hook failed: ${String(error)}`);
      }

      return undefined;
    },
    { priority: -90 }
  );

  logger.info("[otel] Registered message_sent hook (via api.on)");

  // -- before_agent_start ----------------------------------------------
  // Creates an "agent turn" child span under the root request span.

  api.on(
    "before_agent_start",
    (event: any, ctx: any) => {
      try {
        const sessionIdentities = resolveSessionIdentities(event, ctx);
        const sessionKey = sessionIdentities[0] || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const model = event?.model || "unknown";

        let sessionCtx = getSessionTraceContext(event, ctx);
        const pendingSpawnHandoff = consumePendingSpawnHandoff(agentId);
        if (!sessionCtx) {
          const rootSeed: RootSpanSeed | undefined = pendingSpawnHandoff
            ? {
                parentContext: pendingSpawnHandoff.parentContext,
                links: [
                  {
                    context: pendingSpawnHandoff.spawnToolSpanContext,
                    attributes: {
                      "link.type": "agent_spawn",
                      "openclaw.handoff.source_session": pendingSpawnHandoff.sourceSessionKey,
                      "openclaw.handoff.source_agent": pendingSpawnHandoff.sourceAgentId,
                    },
                  },
                  ...(pendingSpawnHandoff.sourceAgentSpanContext
                    ? [{
                        context: pendingSpawnHandoff.sourceAgentSpanContext,
                        attributes: {
                          "link.type": "agent_handoff",
                          "ioa_observe.agent.previous": pendingSpawnHandoff.sourceAgentId,
                          "ioa_observe.agent.previous_sequence": pendingSpawnHandoff.sourceAgentSequence,
                        },
                      }]
                    : []),
                ],
                attributes: {
                  "openclaw.handoff.source_session": pendingSpawnHandoff.sourceSessionKey,
                  "openclaw.handoff.source_agent": pendingSpawnHandoff.sourceAgentId,
                },
              }
            : undefined;

          sessionCtx = startRootSpan(
            tracer,
            event,
            ctx,
            config,
            logger,
            securityCounters,
            counters,
            rootSeed
          );
        }
        const parentContext = sessionCtx?.rootContext || context.active();

        if (pendingSpawnHandoff?.sourceAgentSpanContext) {
          seedHandoffState(sessionKey, {
            lastAgentSpanContext: pendingSpawnHandoff.sourceAgentSpanContext,
            lastAgentName: pendingSpawnHandoff.sourceAgentId,
            sequence: pendingSpawnHandoff.sourceAgentSequence,
          });
        }

        // Check for join from a previous parallel fork
        const joinInfo = consumeJoin(sessionKey);
        const joinLinks: Link[] = joinInfo?.links ?? [];
        if (joinInfo) {
          logger.info(
            `[otel] Join detected for agent=${agentId}: forkId=${joinInfo.attributes["ioa_observe.join.fork_id"]}, ` +
            `branches=${joinInfo.attributes["ioa_observe.join.branch_count"]}`
          );
        }

        // Prepare handoff links before span creation so OTel records them.
        const handoff = onAgentStart(sessionKey, agentId);
        const agentLinks: Link[] = [...joinLinks, ...handoff.links];

        // Create agent turn span as child of root span
        const agentSpan = tracer.startSpan(
          "openclaw.agent.turn",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              [ATTR_OBSERVE_SPAN_KIND]: ObserveSpanKind.AGENT,
              [ATTR_OBSERVE_ENTITY_NAME]: agentId,
              "openclaw.agent.id": agentId,
              "openclaw.session.key": sessionKey,
              "openclaw.agent.model": model,
              ...handoff.attributes,
            },
            links: agentLinks,
          },
          parentContext
        );

        if (config.captureContent && sessionCtx?.latestInput) {
          setCapturedContent(agentSpan, "input", sessionCtx.latestInput, ["openclaw.agent"]);
        }

        // Annotate join metadata if this agent follows a fork
        if (joinInfo) {
          for (const key of Object.keys(joinInfo.attributes)) {
            agentSpan.setAttribute(key, joinInfo.attributes[key]);
          }
          agentSpan.addEvent("agent.join", {
            "ioa_observe.join.fork_id": joinInfo.attributes["ioa_observe.join.fork_id"],
            "ioa_observe.join.branch_count": joinInfo.attributes["ioa_observe.join.branch_count"],
          });
        }

        registerAgentSpan(sessionKey, agentId, agentSpan, handoff.sequence, handoff.previousAgentName);
        if (handoff.links.length > 0) {
          logger.debug(
            `[otel] Handoff links prepared for agent=${agentId}: ${handoff.links.length} link(s), ` +
            `seq=${handoff.attributes["ioa_observe.agent.sequence"]}, ` +
            `previous=${handoff.attributes["ioa_observe.agent.previous"] || "(none)"}`
          );
        }

        const agentContext = trace.setSpan(parentContext, agentSpan);

        // Expose the agent context globally so AgentAwareContextManager in preload.mjs
        // can return it when context.active() has no span (broken async chain between
        // hook dispatch and the auto-instrumented Anthropic/OpenAI call).
        (globalThis as any).__OPENCLAW_ACTIVE_AGENT_CONTEXT = agentContext;

        // Store agent span context for tool spans
        if (sessionCtx) {
          setSessionTraceContext(sessionCtx, event, ctx);
          sessionCtx.agentSpan = agentSpan;
          sessionCtx.agentContext = agentContext;
        } else if (sessionKey !== "unknown") {
          setSessionTraceContext({
            sessionKey,
            rootSpan: agentSpan,
            rootContext: agentContext,
            agentSpan,
            agentContext,
            startTime: Date.now(),
          }, event, ctx);
        }

        // Register in activeAgentSpans for diagnostics integration
        registerActiveAgentSpan(sessionIdentities, agentSpan);

        logger.info?.(`[otel] Agent turn started: agent=${agentId}, model=${model}, session=${sessionKey}`);
      } catch (error) {
        logger.debug(`[otel] before_agent_start hook failed: ${String(error)}`);
      }

      // Return undefined - don't modify system prompt
      return undefined;
    },
    { priority: 90 }
  );

  logger.info("[otel] Registered before_agent_start hook (via api.on)");

  api.on(
    "before_model_resolve",
    (event: any, ctx: any) => {
      // Not implemented at the moment
      return undefined;
    }
  );
 logger.info("[otel] Registered before_model_resolve hook (via api.on)");
  api.on(
    "before_prompt_build",
    (event: any, ctx: any) => {
      // Not implemented at the moment
      return undefined;
    }
  );
  logger.info("[otel] Registered before_prompt_build hook (via api.on)");

  // ── before_tool_call ─────────────────────────────────────────────
  // Creates the tool span at call time, capturing input and running security
  // checks. The span is stored in pendingToolSpans and closed in
  // tool_result_persist once the output is available.
  // SYNCHRONOUS — must not return a Promise.

  api.on(
    "before_tool_call",
    (event: any, ctx: any) => {
      try {
        const toolName = event?.toolName || event?.name || "unknown";
        const toolCallId = event?.toolCallId || event?.id || "";
        const isSynthetic = event?.isSynthetic === true;
        const sessionKey = resolveSessionKey(event, ctx);
        const agentId = ctx?.agentId || "unknown";

        // Tool input is available in event.input for security checks
        const toolInput = event?.input || event?.params || event?.toolInput || event?.args || {};

        // Record metric
        counters.toolCalls.add(1, {
          "tool.name": toolName,
          "session.key": sessionKey,
        });

        // Get parent context - prefer agent turn span, fall back to root
        const sessionCtx = getSessionTraceContext(event, ctx);
        const parentContext = sessionCtx?.agentContext || sessionCtx?.rootContext || context.active();

        // Create tool span as child of agent turn
        const span = tracer.startSpan(
          `tool.${toolName}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              [ATTR_OBSERVE_SPAN_KIND]: ObserveSpanKind.TOOL,
              [ATTR_OBSERVE_ENTITY_NAME]: toolName,
              "openclaw.tool.name": toolName,
              "openclaw.tool.call_id": toolCallId,
              "openclaw.tool.is_synthetic": isSynthetic,
              "openclaw.session.key": sessionKey,
              "openclaw.agent.id": agentId,
            },
          },
          parentContext
        );

        // Track session activity
        touchSession(sessionKey, parentContext);

        // Fork detection - register this tool span for parallel detection
        const agentSequence = getHandoffSequence(sessionKey);
        const forkAttrs = registerToolSpan(sessionKey, toolName, span, agentId, agentSequence);
        if (forkAttrs) {
          for (const key of Object.keys(forkAttrs)) {
            span.setAttribute(key, forkAttrs[key]);
          }
          logger.info(
            `[otel] Tool in fork group: tool=${toolName}, forkId=${forkAttrs["ioa_observe.fork.id"]}, ` +
            `branch=${forkAttrs["ioa_observe.fork.branch_index"]}`
          );
        }

        // Capture tool input if configured
        if (config.captureContent) {
          setCapturedContent(span, "input", toolInput, ["openclaw.tool"]);
        }

        // SECURITY DETECTION 1 & 3: File Access & Dangerous Commands
        const securityEvent = checkToolSecurity(
          toolName,
          toolInput,
          span,
          securityCounters,
          sessionKey,
          agentId
        );
        if (securityEvent) {
          logger.warn(`[otel] SECURITY: ${securityEvent.detection} - ${securityEvent.description}`);
          // Add tool input details to span for forensics
          if (toolInput) {
            const inputStr = JSON.stringify(toolInput).slice(0, 1000);
            span.setAttribute("openclaw.tool.input_preview", inputStr);
          }
        }

        // Store span so tool_result_persist can add the output and close it
        if (toolCallId) {
          pendingToolSpans.set(toolCallId, span);
        } else {
          // No toolCallId to key on — close immediately with no output
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        }

        logger.info?.(`[otel] Tool span started: tool=${toolName}, callId=${toolCallId}, session=${sessionKey}`);
      } catch {
        // Never let telemetry errors break the main flow
      }
      return undefined;
    }
  );

  // ── tool_result_persist ──────────────────────────────────────────
  // Looks up the span created in before_tool_call, attaches output metadata,
  // and closes the span.
  // SYNCHRONOUS — must not return a Promise.

  api.on(
    "tool_result_persist",
    (event: any, ctx: any) => {
      try {
        const toolName = event?.toolName || "unknown";
        const toolCallId = event?.toolCallId || "";
        const sessionKey = resolveSessionKey(event, ctx);
        const agentId = ctx?.agentId || "unknown";

        // Retrieve the span opened in before_tool_call
        const span = toolCallId ? pendingToolSpans.get(toolCallId) : undefined;
        if (!span) {
          logger.warn?.(`[otel] No pending span for toolCallId=${toolCallId}, tool=${toolName} — skipping output capture`);
          return undefined;
        }
        pendingToolSpans.delete(toolCallId);

        // Prefer toolInput captured on the span in before_tool_call; fall back to event fields.
        const toolInput =
          (span as any).attributes?.["openclaw.tool.input"] ??
          (span as any).attributes?.[ATTR_OBSERVE_ENTITY_INPUT] ??
          event?.input ?? event?.params ?? event?.toolInput ?? event?.args;

        const sessionCtx = getSessionTraceContext(event, ctx);
        const parentContext = sessionCtx?.agentContext || sessionCtx?.rootContext || context.active();

        const agentSequence = getHandoffSequence(sessionKey);
        // Inspect the message for result metadata
        const message = event?.message;
        if (message) {
          if (toolName === "sessions_spawn") {
            const targetAgentIds = extractSpawnTargetAgentIds(toolInput, message);
            const sourceAgentSpanContext = sessionCtx?.agentSpan?.spanContext();

            for (const targetAgentId of targetAgentIds) {
              queuePendingSpawnHandoff({
                targetAgentId,
                sourceSessionKey: sessionKey,
                sourceAgentId: agentId,
                sourceAgentSequence: agentSequence,
                sourceAgentSpanContext,
                spawnToolSpanContext: span.spanContext(),
                parentContext: trace.setSpan(parentContext, span),
                createdAt: Date.now(),
              });
            }

            if (targetAgentIds.length > 0) {
              logger.info(
                `[otel] Prepared subagent handoff from agent=${agentId} to ` +
                `[${targetAgentIds.join(", ")}], session=${sessionKey}`
              );
            } else {
              logger.debug(
                `[otel] sessions_spawn result captured but target agent could not be resolved, session=${sessionKey}`
              );
            }
          }

          const contentArray = message?.content;
          if (contentArray && Array.isArray(contentArray)) {
            const textParts = contentArray
              .filter((c: any) => c.type === "text")
              .map((c: any) => String(c.text || ""));
            const totalChars = textParts.reduce((sum: number, t: string) => sum + t.length, 0);
            span.setAttribute("openclaw.tool.result_chars", totalChars);
            span.setAttribute("openclaw.tool.result_parts", contentArray.length);
          }

          if (config.captureContent) {
            setCapturedContent(
              span,
              "output",
              extractToolOutputPayload(event, message),
              ["openclaw.tool"]
            );
          }

          if (message?.is_error === true || message?.isError === true) {
            counters.toolErrors.add(1, { "tool.name": toolName });
            span.setStatus({ code: SpanStatusCode.ERROR, message: "Tool execution error" });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        span.end();
        logger.info?.(`[otel] Tool span ended: tool=${toolName}, callId=${toolCallId}, session=${sessionKey}`);
      } catch {
        // Never let telemetry errors break the main flow
      }

      // Return undefined to keep the tool result unchanged
      return undefined;
    },
    { priority: -100 }
  );

  logger.info("[otel] Registered tool_result_persist hook (via api.on)");

  // -- agent_end -------------------------------------------------------
  // Ends the agent turn span AND the root request span.
  // Event shape from OpenClaw:
  //   event: { messages, success, error?, durationMs }
  //   ctx:   { agentId, sessionKey, workspaceDir, messageProvider? }
  // Token usage is embedded in the last assistant message's .usage field.

  api.on(
    "agent_end",
    async (event: any, ctx: any) => {
      try {
        const sessionIdentities = resolveSessionIdentities(event, ctx);
        const sessionKey = sessionIdentities[0] || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const durationMs = event?.durationMs;
        const success = event?.success !== false;
        const errorMsg = event?.error;

        // Try to get usage from diagnostic events (includes cost!)
        const diagUsage = getPendingUsage(sessionIdentities);

        // Fallback: Extract token usage from the messages array
        const messages: any[] = event?.messages || [];
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;
        let model = "unknown";
        let costUsd: number | undefined;

        if (diagUsage) {
          // Use diagnostic event data (more accurate, includes cost)
          totalInputTokens = diagUsage.usage.input || 0;
          totalOutputTokens = diagUsage.usage.output || 0;
          cacheReadTokens = diagUsage.usage.cacheRead || 0;
          cacheWriteTokens = diagUsage.usage.cacheWrite || 0;
          model = diagUsage.model || "unknown";
          costUsd = diagUsage.costUsd;
          logger.debug(`[otel] agent_end using diagnostic data: cost=$${costUsd?.toFixed(4) || "?"}`);
        } else {
          // Fallback: parse messages manually
          for (const msg of messages) {
            if (msg?.role === "assistant" && msg?.usage) {
              const u = msg.usage;
              // pi-ai stores usage as .input/.output (normalized names)
              if (typeof u.input === "number") totalInputTokens += u.input;
              else if (typeof u.inputTokens === "number") totalInputTokens += u.inputTokens;
              else if (typeof u.input_tokens === "number") totalInputTokens += u.input_tokens;

              if (typeof u.output === "number") totalOutputTokens += u.output;
              else if (typeof u.outputTokens === "number") totalOutputTokens += u.outputTokens;
              else if (typeof u.output_tokens === "number") totalOutputTokens += u.output_tokens;

              if (typeof u.cacheRead === "number") cacheReadTokens += u.cacheRead;
              if (typeof u.cacheWrite === "number") cacheWriteTokens += u.cacheWrite;
            }
            if (msg?.role === "assistant" && msg?.model) {
              model = msg.model;
            }
          }
        }

        const totalTokens = totalInputTokens + totalOutputTokens + cacheReadTokens + cacheWriteTokens;
        logger.debug(`[otel] agent_end tokens: input=${totalInputTokens}, output=${totalOutputTokens}, cache_read=${cacheReadTokens}, cache_write=${cacheWriteTokens}, model=${model}`);

        const sessionCtx = getSessionTraceContext(event, ctx);

        // End the agent turn span
        if (sessionCtx?.agentSpan) {
          const agentSpan = sessionCtx.agentSpan;

          if (config.captureContent) {
            setCapturedContent(
              agentSpan,
              "output",
              extractLatestAssistantOutput(messages),
              ["openclaw.agent"]
            );
          }

          if (typeof durationMs === "number") {
            agentSpan.setAttribute("openclaw.agent.duration_ms", durationMs);
          }

          // Token usage - GenAI semantic convention attributes
          agentSpan.setAttribute("gen_ai.usage.input_tokens", totalInputTokens);
          agentSpan.setAttribute("gen_ai.usage.output_tokens", totalOutputTokens);
          agentSpan.setAttribute("gen_ai.usage.total_tokens", totalTokens);
          agentSpan.setAttribute("gen_ai.response.model", model);
          agentSpan.setAttribute("openclaw.agent.success", success);
          if (model !== "unknown") {
            agentSpan.setAttribute("openclaw.agent.model", model);
          }

          // Cache tokens (custom attributes)
          if (cacheReadTokens > 0) {
            agentSpan.setAttribute("gen_ai.usage.cache_read_tokens", cacheReadTokens);
          }
          if (cacheWriteTokens > 0) {
            agentSpan.setAttribute("gen_ai.usage.cache_write_tokens", cacheWriteTokens);
          }

          // Cost (from diagnostic events) - this is the key addition!
          if (typeof costUsd === "number") {
            agentSpan.setAttribute("openclaw.llm.cost_usd", costUsd);
          }

          if (diagUsage?.provider) {
            agentSpan.setAttribute("gen_ai.system", diagUsage.provider);
          }

          // Context window (from diagnostic events)
          if (diagUsage?.context?.limit) {
            agentSpan.setAttribute("openclaw.context.limit", diagUsage.context.limit);
          }
          if (diagUsage?.context?.used) {
            agentSpan.setAttribute("openclaw.context.used", diagUsage.context.used);
          }

          // Record metrics only if we didn't get them from diagnostics
          // (diagnostics module already records metrics on model.usage event)
          if (!diagUsage && (totalInputTokens > 0 || totalOutputTokens > 0)) {
            const metricAttrs = {
              "gen_ai.response.model": model,
              "openclaw.agent.id": agentId,
            };
            counters.tokensPrompt.add(totalInputTokens + cacheReadTokens + cacheWriteTokens, metricAttrs);
            counters.tokensCompletion.add(totalOutputTokens, metricAttrs);
            counters.tokensTotal.add(totalTokens, metricAttrs);
            counters.llmRequests.add(1, metricAttrs);
          }

          // Record duration histogram
          if (typeof durationMs === "number") {
            histograms.agentTurnDuration.record(durationMs, {
              "gen_ai.response.model": model,
              "openclaw.agent.id": agentId,
            });
          }

          // Finalize fork/join detection for this agent turn
          const forkResult = finalizeAgentTurn(sessionKey);
          if (forkResult) {
            agentSpan.setAttribute("ioa_observe.fork.id", forkResult.forkId);
            agentSpan.setAttribute("ioa_observe.fork.branch_count", forkResult.branchCount);
            agentSpan.addEvent("agent.fork_completed", {
              "ioa_observe.fork.id": forkResult.forkId,
              "ioa_observe.fork.branch_count": forkResult.branchCount,
            });
            logger.info(
              `[otel] Fork completed: agent=${agentId}, forkId=${forkResult.forkId}, branches=${forkResult.branchCount}`
            );
          }

          // Update handoff state so next agent can link back
          onAgentEnd(sessionKey, agentId, agentSpan);
          logger.info(
            `[otel] Agent turn ended: agent=${agentId}, session=${sessionKey}, ` +
            `success=${success}, duration=${durationMs ?? "?"}ms, ` +
            `tokens=${totalTokens}, cost=$${costUsd?.toFixed(4) ?? "?"}`
          );

          if (errorMsg) {
            agentSpan.setAttribute("openclaw.agent.error", String(errorMsg).slice(0, 500));
            agentSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(errorMsg).slice(0, 200) });
          } else {
            agentSpan.setStatus({ code: SpanStatusCode.OK });
          }

          agentSpan.end();
        }

        // End the root request span
        if (sessionCtx?.rootSpan && sessionCtx.rootSpan !== sessionCtx.agentSpan) {
          const totalMs = Date.now() - sessionCtx.startTime;
          sessionCtx.rootSpan.setAttribute("openclaw.request.duration_ms", totalMs);
          sessionCtx.rootSpan.setStatus({ code: SpanStatusCode.OK });
          sessionCtx.rootSpan.end();
        }

        // Clean up all per-session state
        deleteSessionTraceContext(sessionCtx);
        unregisterActiveAgentSpan(sessionIdentities);
        cleanupHandoff(sessionKey);
        cleanupForkJoin(sessionKey);
        // Clear the global agent context fallback set in before_agent_start
        (globalThis as any).__OPENCLAW_ACTIVE_AGENT_CONTEXT = undefined;

        logger.info(`[otel] Trace completed for session=${sessionKey}`);
      } catch (error) {
        logger.debug(`[otel] agent_end hook failed: ${String(error)}`);
        // Silently ignore
      }
    },
    { priority: -100 }
  );

  logger.info("[otel] Registered agent_end hook (via api.on)");

  // ==================================================================
  // EVENT-STREAM HOOKS - registered via api.registerHook()
  // ==================================================================

  // -- Command event hooks ---------------------------------------------

  api.registerHook(
    ["command:new", "command:reset", "command:stop"],
    async (event: any) => {
      try {
        const action = event?.action || "unknown";
        const sessionKey = event?.sessionKey || "unknown";

        // Get parent context if available
        const sessionCtx = sessionContextMap.get(sessionKey);
        const parentContext = sessionCtx?.rootContext || context.active();

        const span = tracer.startSpan(
          `openclaw.command.${action}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "openclaw.command.action": action,
              "openclaw.command.session_key": sessionKey,
              "openclaw.command.source": event?.context?.commandSource || "unknown",
            },
          },
          parentContext
        );

        if (action === "new" || action === "reset") {
          counters.sessionResets.add(1, {
            "command.source": event?.context?.commandSource || "unknown",
          });
          // End session lifecycle tracking on reset
          endSession(sessionKey);
          logger.info(`[otel] Session ended via command:${action}: session=${sessionKey}`);
        }

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch {
        // Silently ignore telemetry errors
      }
    },
    {
      name: "otel-command-events",
      description: "Records session command spans via OpenTelemetry",
    }
  );

  logger.info("[otel] Registered command event hooks (via api.registerHook)");

  // -- Gateway startup hook --------------------------------------------

  api.registerHook(
    "gateway:startup",
    async (event: any) => {
      try {
        const span = tracer.startSpan("openclaw.gateway.startup", {
          kind: SpanKind.INTERNAL,
          attributes: {
            "openclaw.event.type": "gateway",
            "openclaw.event.action": "startup",
          },
        });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch {
        // Silently ignore
      }
    },
    {
      name: "otel-gateway-startup",
      description: "Records gateway startup event via OpenTelemetry",
    }
  );

  logger.info("[otel] Registered gateway:startup hook (via api.registerHook)");

  // -- Periodic cleanup ------------------------------------------------
  // Safety net: clean up stale session contexts (e.g., if agent_end never fires)
  setInterval(() => {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes
    const seen = new Set<SessionTraceContext>();
    for (const [, ctx] of sessionContextMap) {
      if (seen.has(ctx)) {
        continue;
      }
      seen.add(ctx);

      if (now - ctx.startTime > maxAge) {
        try {
          ctx.agentSpan?.end();
          if (ctx.rootSpan !== ctx.agentSpan) ctx.rootSpan?.end();
        } catch { /* ignore */ }
        deleteSessionTraceContext(ctx);
        unregisterActiveAgentSpan([ctx.sessionKey]);
        cleanupHandoff(ctx.sessionKey);
        cleanupForkJoin(ctx.sessionKey);
        logger.debug(`[otel] Cleaned up stale trace context for session=${ctx.sessionKey}`);
      }
    }
  }, 60_000);
}

export default registerHooks;
