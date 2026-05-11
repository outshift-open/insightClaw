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
import {
  getPendingUsage,
  normalizeUsageData,
  registerActiveAgentSpan,
  setMessageProcessedObserver,
  unregisterActiveAgentSpan,
  type MessageProcessedDiagnosticEvent,
} from "./diagnostics.js";
import { onAgentStart, onAgentEnd, cleanupHandoff, getHandoffSequence, registerAgentSpan, seedHandoffState, setHandoffLogger } from "./handoff.js";
import { registerToolSpan, finalizeAgentTurn, consumeJoin, cleanupForkJoin, setForkJoinLogger } from "./forkjoin.js";
import {
  ObserveSpanKind,
  ATTR_OBSERVE_SPAN_KIND,
  ATTR_OBSERVE_ENTITY_NAME,
  ATTR_OBSERVE_ENTITY_INPUT,
  ATTR_OBSERVE_ENTITY_OUTPUT,
} from "./observe-attributes.js";
import {
  annotateMemoryToolSpan,
  recordMemoryFailureRateFromCache,
  recordMemoryToolMetrics,
} from "./memory-metrics.js";
import { touchSession, endSession, getSessionId, getSessionContext, getSessionSpanContext } from "./session-lifecycle.js";
import { recordSpan, type SpanAttributeValue, type SpanRecord } from "./span-cache.js";
import { calculateCoverage, getNoveltyScore} from "./context-analysis.js";

/** Snapshot span attributes and identifiers into the span cache just before span.end(). */
function snapshotSpanAttributes(span: Span): Record<string, SpanAttributeValue> {
  const rawAttributes = (span as any).attributes;

  if (rawAttributes instanceof Map) {
    return Object.fromEntries(
      [...rawAttributes.entries()].filter((entry): entry is [string, SpanAttributeValue] => {
        const [, value] = entry;
        return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
      })
    );
  }

  if (rawAttributes && typeof rawAttributes === "object") {
    return Object.fromEntries(
      Object.entries(rawAttributes).filter((entry): entry is [string, SpanAttributeValue] => {
        const [, value] = entry;
        return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
      })
    );
  }

  return {};
}

function captureSpanToCache(
  span: Span,
  spanName: string,
  spanKind: string,
  sessionKey: string,
  sessionId?: string
): void {
  try {
    const { traceId, spanId } = span.spanContext();
    const record: SpanRecord = {
      traceId,
      spanId,
      spanName,
      spanKind,
      sessionKey,
      sessionId,
      attributes: snapshotSpanAttributes(span),
      statusCode: (span as any).status?.code,
      recordedAt: Date.now(),
    };
    recordSpan(record);
  } catch {
    // Never let cache errors affect span emission
  }
}

/** Active trace context for an OpenClaw runtime session. */
interface SessionTraceContext {
  runtimeSessionKey: string;
  messageChannel: string;
  rootSpan: Span;
  rootContext: Context;
  agentSpan?: Span;
  agentContext?: Context;
  agentId?: string;
  messageSentAt?: number;
  pendingRootRuntimeSessionIdentities?: string[];
  rootCompletionDeadlineAt?: number;
  latestInput?: string;
  latestOutput?: unknown;
  lastLifecycleEvent?: string;
  lastLifecycleAt?: number;
  /** SpanContext of the session.start span of the session this agent held before being merged via sessions_send. */
  previousSessionStartSpanContext?: SpanContext;
  startTime: number;
}

interface PendingSpawnHandoff {
  targetAgentId: string;
  sourceRuntimeSessionKey: string;
  sourceSessionId?: string;
  sourceAgentId: string;
  sourceAgentSequence: number;
  sourceAgentSpanContext?: SpanContext;
  spawnToolSpanContext: SpanContext;
  parentContext: Context;
  /** "agent_spawn" for sessions_spawn, "agent_send" for sessions_send */
  linkType: string;
  createdAt: number;
}

interface RootSpanSeed {
  parentContext?: Context;
  links?: Link[];
  attributes?: Record<string, string | number | boolean>;
  sessionId?: string;
}

interface PendingToolSpan {
  span: Span;
  startedAt: number;
}

interface PendingLlmSpan {
  span: Span;
  runtimeSessionKey: string;
  agentId: string;
}

interface DeferredAgentCompletion {
  runtimeSessionIdentities: string[];
  runtimeSessionKey: string;
  agentId: string;
  durationMs?: number;
  success: boolean;
  errorMsg?: unknown;
  messages: any[];
  diagUsage?: any;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  model: string;
  costUsd?: number;
  sessionCtx?: SessionTraceContext;
}

interface HookConfiguration {
  otel_config: OtelObservabilityConfig;
  tracer: TelemetryRuntime["tracer"];
  counters: TelemetryRuntime["counters"];
  histograms: TelemetryRuntime["histograms"];
  pendingToolSpans: Map<string, PendingToolSpan>;
  pendingLlmSpans: Map<string, PendingLlmSpan>;

  logger: any;
}

interface ToolStatus {
  status: string;
  exitCode: number;
}

/** Map of runtime session key -> active trace context. Cleaned up when the request span closes. */
const sessionContextMap = new Map<string, SessionTraceContext>();
const pendingSpawnHandoffs = new Map<string, PendingSpawnHandoff[]>();
const contextPrepTimers = new Map<string, number>();
const pendingAgentContextsMap = new Map<string, any>(); //Note: this should be moved to the plugin cache once it will support the feature
const targetAgentsMap = new Map<string, string>(); //Note: this should be moved to the plugin cache once it will support the feature
const PENDING_SPAWN_TTL_MS = 60_000;
const ROOT_COMPLETION_GRACE_MS = 30_000;
const MAX_CAPTURE_CONTENT_CHARS = 4_096;

const GEN_AI_OPERATION_NAME_ATTR = "gen_ai.operation.name";
const GEN_AI_AGENT_NAME_ATTR = "gen_ai.agent.name";
const GEN_AI_CONVERSATION_ID_ATTR = "gen_ai.conversation.id";
const GEN_AI_TOOL_NAME_ATTR = "gen_ai.tool.name";
const GEN_AI_TOOL_CALL_ID_ATTR = "gen_ai.tool.call.id";

const GEN_AI_OPERATION = {
  CHAT: "chat",
  EXECUTE_TOOL: "execute_tool",
  INVOKE_AGENT: "invoke_agent",
} as const;

function initHookConfig(
  otel_config: OtelObservabilityConfig,
  getTelemetry: () => TelemetryRuntime,
  logger: any
): HookConfiguration {
  const telemetry = getTelemetry();
  return {
    otel_config,
    tracer: telemetry?.tracer,
    counters: telemetry?.counters,
    histograms: telemetry?.histograms,
    pendingToolSpans: new Map<string, PendingToolSpan>(),
    pendingLlmSpans: new Map<string, PendingLlmSpan>(),
    logger,
  };
}

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

/** Non-consuming peek — returns the freshest pending handoff without removing it. */
function peekPendingSpawnHandoff(agentId: string): PendingSpawnHandoff | undefined {
  const existing = pendingSpawnHandoffs.get(agentId);
  if (!existing || existing.length === 0) return undefined;
  const cutoff = Date.now() - PENDING_SPAWN_TTL_MS;
  return existing.find((entry) => entry.createdAt >= cutoff);
}

function resolveRuntimeSessionKey(event?: any, ctx?: any): string {
  return resolveRuntimeSessionIdentities(event, ctx)[0] || "unknown";
}

function resolveRuntimeSessionIdentities(event?: any, ctx?: any): string[] {
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
  for (const runtimeSessionIdentity of resolveRuntimeSessionIdentities(event, ctx)) {
    const sessionCtx = sessionContextMap.get(runtimeSessionIdentity);
    if (sessionCtx) {
      return sessionCtx;
    }
  }

  return undefined;
}

function getSessionTraceContextByIdentities(runtimeSessionIdentities: string[]): SessionTraceContext | undefined {
  for (const runtimeSessionIdentity of runtimeSessionIdentities) {
    const sessionCtx = sessionContextMap.get(runtimeSessionIdentity);
    if (sessionCtx) {
      return sessionCtx;
    }
  }

  return undefined;
}

function setSessionTraceContext(sessionCtx: SessionTraceContext, event?: any, ctx?: any): void {
  const sessionIdentities = resolveRuntimeSessionIdentities(event, ctx);

  if (sessionIdentities.length === 0) {
    sessionContextMap.set(sessionCtx.runtimeSessionKey, sessionCtx);
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

function markLifecycleEvent(sessionCtx: SessionTraceContext | undefined, eventName: string): void {
  if (!sessionCtx) {
    return;
  }

  sessionCtx.lastLifecycleEvent = eventName;
  sessionCtx.lastLifecycleAt = Date.now();
}

function formatSessionTraceState(sessionCtx: SessionTraceContext | undefined): string {
  if (!sessionCtx) {
    return "hasSessionCtx=false";
  }

  const lastEvent = sessionCtx.lastLifecycleEvent || "unknown";
  const lastEventAgeMs = sessionCtx.lastLifecycleAt == null
    ? "?"
    : Math.max(0, Date.now() - sessionCtx.lastLifecycleAt);

  return (
    `hasSessionCtx=true, pendingRoot=${sessionCtx.pendingRootRuntimeSessionIdentities ? "true" : "false"}, ` +
    `agentActive=${sessionCtx.agentSpan ? "true" : "false"}, lastEvent=${lastEvent}, ` +
    `lastEventAgeMs=${lastEventAgeMs}`
  );
}

function getSessionIdAttrs(runtimeSessionKey: string): Record<string, string> {
  if (runtimeSessionKey === "unknown") {
    return {};
  }

  const sessionId = getSessionId(runtimeSessionKey);
  return sessionId ? { "session.id": sessionId } : {};
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

function getToolStatus(event: any): ToolStatus | undefined {
  const result = event?.result ?? event?.message;
  const details = result?.details;
  const error = event?.error ?? details?.error ?? null;

  if (details != null) {
    const status = details.status;
    const exitCode = details.exitCode;
    // check first that the status and exitCode are explicitly provided
    if (status != null && exitCode != null) {
      return { status, exitCode };
    } else if (status != null) {
      return { status, exitCode: -1 };
    } else if (exitCode != null) {
      return { status: "unknown", exitCode };
    }
    // fallback on the error field
    if (error != null) {
      return { status: "error", exitCode: -1 };
    }
    return undefined;
  } else {
    // no details provided, but error might have been populated
    if (error != null) {
      return { status: "error", exitCode: -1 };
    }
  }
}

function handleToolOutput(
    event: any,
    ctx: any,
    config: HookConfiguration,
  ): void {
  const toolName = event?.toolName || "unknown";
  const toolCallId = event?.toolCallId || "";
  const runtimeSessionKey = resolveRuntimeSessionKey(event, ctx);
  const agentId = ctx?.agentId || "unknown";

  // Retrieve the span opened in before_tool_call
  const pendingTool = toolCallId ? config.pendingToolSpans.get(toolCallId) : undefined;
  if (!pendingTool) {
    config.logger.warn?.(`[otel] No pending span for toolCallId=${toolCallId}, tool=${toolName} — skipping output capture`);
    return undefined;
  }
  config.pendingToolSpans.delete(toolCallId);

  const { span, startedAt } = pendingTool;
  const durationMs = Math.max(0, Date.now() - startedAt);
  span.setAttribute("openclaw.tool.duration_ms", durationMs);
  config.histograms.toolDuration.record(durationMs, {
    "tool.name": toolName,
    "gen_ai.agent.id": agentId,
  });

  // Prefer toolInput captured on the span in before_tool_call; fall back to event fields.
  const toolInput =
    (span as any).attributes?.["openclaw.tool.input"] ??
    (span as any).attributes?.[ATTR_OBSERVE_ENTITY_INPUT] ??
    event?.input ?? event?.params ?? event?.toolInput ?? event?.args;

  const sessionCtx = getSessionTraceContext(event, ctx);
  const parentContext = sessionCtx?.agentContext || sessionCtx?.rootContext || context.active();

  const agentSequence = getHandoffSequence(runtimeSessionKey);
  const sessionId = getSessionId(runtimeSessionKey) || "unknown";

  if (toolName === "sessions_spawn") {
    // sessions_spawn: target agent ID comes from the result, handle post-result.
    handleSessionHandoffCall(toolName, event, span, parentContext, runtimeSessionKey, agentId, agentSequence, toolInput, config.logger);
  }
  const result = event?.result ?? event?.message;
  let memoryOperation: "read" | "write" | "edit" | "search" | undefined;

  if (result) {

    recordMemoryToolMetrics({
      toolName,
      toolInput,
      counters: config.counters,
      histograms: config.histograms,
      sessionId,
      message: result,
      durationMs,
      agentId,
    });
    memoryOperation = annotateMemoryToolSpan(span, toolName, toolInput);

    const contentArray = result?.content;
    if (contentArray && Array.isArray(contentArray)) {
      const textParts = contentArray
        .filter((c: any) => c.type === "text")
        .map((c: any) => String(c.text || ""));
      const totalChars = textParts.reduce((sum: number, t: string) => sum + t.length, 0);
      span.setAttribute("openclaw.tool.result_chars", totalChars);
      span.setAttribute("openclaw.tool.result_parts", contentArray.length);
    }

    if (config.otel_config.captureContent) {
      setCapturedContent(
        span,
        "output",
        extractToolOutputPayload(event, result),
        ["openclaw.tool"]
      );
    }

    const toolStatus = getToolStatus(event);
    if (toolStatus) {
      if (toolStatus.status.toLowerCase() === "completed" || toolStatus.status.toLowerCase() === "accepted" || toolStatus.status.toLowerCase() === "yielded") {
        if (toolStatus.exitCode <= 0) {
          span.setStatus({ code: SpanStatusCode.OK });
        } else {
          span.setStatus({ code: SpanStatusCode.ERROR, message: `Tool exited with code ${toolStatus.exitCode}` });
          config.counters.toolErrors.add(1, {
              "tool.name": toolName,
              "gen_ai.agent.id": agentId,
          });
        }
      } else if (toolStatus.status.toLowerCase() === "failed" || toolStatus.status.toLowerCase() === "error") {
        span.setStatus({ code: SpanStatusCode.ERROR, message: `Tool execution failed with status ${toolStatus.status}` });
        config.counters.toolErrors.add(1, {
              "tool.name": toolName,
              "gen_ai.agent.id": agentId,
          });
      }
    }
  }
  captureSpanToCache(span, `tool.${toolName}`, "tool", runtimeSessionKey, getSessionId(runtimeSessionKey));
  if (memoryOperation) {
    recordMemoryFailureRateFromCache({
      histograms: config.histograms,
      runtimeSessionKey,
      logger: config.logger,
      latestOperation: memoryOperation,
    });
  }

  span.end();
  config.logger.info?.(`[otel] after_tool Tool span ended: tool=${toolName}, callId=${toolCallId}, runtimeSession=${runtimeSessionKey}`);

}

function handleSessionHandoffCall(
    toolName: string,
    event: any,
    span: any,
    parentContext: any,
    runtimeSessionKey: string,
    agentId: string,
    agentSequence: number,
    toolInput: any,
    logger: any,
  ): void {
  const targetAgentIds = extractSpawnTargetAgentIds(toolInput, event);
  const sourceAgentSpanContext = getSessionTraceContext(event)?.agentSpan?.spanContext();
  const linkType = toolName === "sessions_spawn" ? "agent_spawn" : "agent_send";
  for (const targetAgentId of targetAgentIds) {
    queuePendingSpawnHandoff({
      targetAgentId,
      sourceRuntimeSessionKey: runtimeSessionKey,
      sourceSessionId: getSessionId(runtimeSessionKey),
      sourceAgentId: agentId,
      sourceAgentSequence: agentSequence,
      sourceAgentSpanContext,
      spawnToolSpanContext: span.spanContext(),
      parentContext: trace.setSpan(parentContext, span),
      linkType,
      createdAt: Date.now(),
    });
  }
  if (targetAgentIds.length > 0) {
    logger.info(
      `[otel] Prepared agent handoff (${toolName}) from agent=${agentId} to ` +
      `[${targetAgentIds.join(", ")}], runtimeSession=${runtimeSessionKey}`
    );
    for (const targetAgentId of targetAgentIds) {
      targetAgentsMap.set(targetAgentId, agentId + "-" + runtimeSessionKey); //TODO merge with current pendingSpawn struct
    }
  } else {
    logger.debug(
      `[otel] ${toolName} result captured but target agent could not be resolved, runtimeSession=${runtimeSessionKey}`
    );
  }
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

/**
 * Summarizes the content lengths of an LLM input context, similar to parse_llm_input_context in debug.py.
 * @param context The LLM input context object (parsed from JSON)
 */
export function parseContext(event: any, histograms: any, sessionId: any, agentId: any): void {
  // systemPrompt is a string
  const systemPrompt = event?.systemPrompt;
  const prompt = event?.prompt;
  const historyMessages = event?.historyMessages;
  const systemData = typeof systemPrompt === 'string' ? new TextEncoder().encode(systemPrompt).length : 0;
  //let tool_desc = 0; not available at the moment
  let historyTool = 0;
  let historyUser = 0;
  let historyOthers = 0;
  let historyMemory = 0;
  //let others = 0; // not available at the moment

  try {
    const data = historyMessages || [];
    for (const elem of data) {
      const role = elem.role;
      if (role === 'toolResult') {
        const toolName = elem.toolName;
        let isMemoryTool = false;
        if (toolName === 'memory_get' || toolName === 'compactionSummary') {
          isMemoryTool = true;
        } else if (
          toolName === 'read' &&
          elem.arguments &&
          typeof elem.arguments.path === 'string' &&
          elem.arguments.path.includes('memory')
        ) {
          isMemoryTool = true;
        }
        if (isMemoryTool) {
          historyMemory += new TextEncoder().encode(elem.content ?? '').length;
        }
        historyTool += new TextEncoder().encode(elem.content ?? '').length;
      } else if (role === 'user') {
        historyUser += new TextEncoder().encode(elem.content ?? '').length;
      } else {
        historyOthers += new TextEncoder().encode(elem.content ?? '').length;
      }
    }
  } catch (e) {
    console.error('Error decoding historyMessages content, skipping context parsing.', e);
    return;
  }

  historyTool -= historyMemory;

  histograms.contextSystemSize.record(systemData, { 
    "gen_ai.agent.id": agentId,
  });
  
  // not available at the moment
  // histograms.contextToolDescSize.record(tool_desc, { 
  //   "gen_ai.agent.id": agentId,
  //   "openclaw.session.key": sessionKey,
  // });
  histograms.contextHistoryMemorySize.record(historyMemory, { 
    "gen_ai.agent.id": agentId,
  });
  histograms.contextHistoryToolSize.record(historyTool, { 
    "gen_ai.agent.id": agentId,
  });
  histograms.contextHistoryUserSize.record(historyUser, { 
    "gen_ai.agent.id": agentId,
  });

  histograms.contextHistoryOtherSize.record(historyOthers, { 
    "gen_ai.agent.id": agentId,
  });
  
  histograms.contextPromptSize.record(prompt ? new TextEncoder().encode(prompt).length : 0, {
    "gen_ai.agent.id": agentId,
  });

  // not available at the moment
  // histograms.contextOtherSize.record(others, { 
  //   "gen_ai.agent.id": agentId,
  //   "openclaw.session.key": sessionKey,
  // });
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
  counters: any,
  seed?: RootSpanSeed
) {
  const runtimeSessionIdentities = resolveRuntimeSessionIdentities(event, ctx);
  const primaryRuntimeSessionKey = runtimeSessionIdentities[0] || "unknown";

  if (primaryRuntimeSessionKey === "unknown") {
    logger.debug("[otel] Skipping eager request span start because no stable runtime session/conversation key is available yet");
    return undefined;
  }

  const channel = event?.channel || ctx?.channelId || event?.metadata?.channelId || "unknown";
  const from = resolveMessageFrom(event, ctx);
  const messageText = extractMessageText(event);

  const parentContext = seed?.parentContext || context.active();

  // Capture the session.start SpanContext of the existing session BEFORE touchSession
  // so we can link to it if a sessions_send merge happens.
  // Falls back to the openclaw.request span when session.start is not available
  // (e.g. session watcher not started yet).
  const previousSessionIdSnapshot = getSessionId(primaryRuntimeSessionKey);
  const previousSessionStartSpanContext = previousSessionIdSnapshot
    ? (getSessionSpanContext(primaryRuntimeSessionKey) ?? getSessionTraceContext(event, ctx)?.rootSpan.spanContext())
    : undefined;

  // Touch (or create) the session BEFORE creating the request span so that the
  // long-lived session.start span is opened first and can act as the trace root.
  const sessionId = touchSession(primaryRuntimeSessionKey, parentContext, undefined, seed?.sessionId, channel);

  const didMerge = previousSessionIdSnapshot != null && previousSessionIdSnapshot !== sessionId;

  // When a merge occurred, add a link from the new openclaw.request back to the
  // previous session.start span so the two sessions are navigable in the trace UI.
  const sessionMergeLink: Link | undefined = didMerge && previousSessionStartSpanContext
    ? {
        context: previousSessionStartSpanContext,
        attributes: {
          "link.type": "session_merge",
          "session.id": previousSessionIdSnapshot!,
        },
      }
    : undefined;

  // For spawned sub-agents, seed.parentContext explicitly points to the
  // sessions_spawn tool span. Overriding it with getSessionContext() would
  // reparent openclaw.request onto the *parent* session's session.start span,
  // severing the spawn-tool → sub-agent link in the trace.
  // For normal inbound messages (no explicit parent), nest openclaw.request
  // under the fresh session.start span so it acts as the true trace root.
  const sessionParentContext = seed?.parentContext != null
    ? parentContext
    : (getSessionContext(primaryRuntimeSessionKey) ?? parentContext);

  const allLinks = [...(seed?.links ?? []), ...(sessionMergeLink ? [sessionMergeLink] : [])];

  const rootSpan = tracer.startSpan(
    "openclaw.request",
    {
      kind: SpanKind.SERVER,
      attributes: {
        [ATTR_OBSERVE_SPAN_KIND]: ObserveSpanKind.WORKFLOW,
        [ATTR_OBSERVE_ENTITY_NAME]: "openclaw.request",
        "openclaw.message.channel": channel,
        "openclaw.session.key": primaryRuntimeSessionKey,
        "openclaw.message.direction": "inbound",
        "openclaw.message.from": from,
        ...seed?.attributes,
      },
      links: allLinks.length > 0 ? allLinks : undefined,
    },
    sessionParentContext
  );

  const rootContext = trace.setSpan(sessionParentContext, rootSpan);
  rootSpan.setAttribute("session.id", sessionId);
  const capturedInput = config.captureContent
    ? setCapturedContent(rootSpan, "input", messageText, ["openclaw.request"])
    : undefined;
  const sessionCtx: SessionTraceContext = {
    runtimeSessionKey: primaryRuntimeSessionKey,
    messageChannel: channel,
    rootSpan,
    rootContext,
    latestInput: capturedInput,
    previousSessionStartSpanContext: sessionMergeLink ? previousSessionStartSpanContext : undefined,
    lastLifecycleEvent: "root_started",
    lastLifecycleAt: Date.now(),
    startTime: Date.now(),
  };

  setSessionTraceContext(sessionCtx, event, ctx);

  counters.messagesReceived.add(1, {
    "openclaw.message.channel": channel,
  });

  logger.info(`[otel] Root span started for runtimeSession=${primaryRuntimeSessionKey}, channel=${channel}`);
  return sessionCtx;
}

/**
 * Register all plugin hooks on the OpenClaw plugin API.
 */
export function registerHooks(
  api: any,
  getTelemetry: () => TelemetryRuntime,
  config: OtelObservabilityConfig
): void {

  // Interface to hold references to telemetry components and shared state for hooks
  const hookConfig = initHookConfig(config, getTelemetry, api.logger);

  let tracer = hookConfig.tracer;
  let counters = hookConfig.counters;
  let histograms = hookConfig.histograms;

  const logger = hookConfig.logger;
  // Initialize loggers for sub-modules
  setHandoffLogger(logger);
  setForkJoinLogger(logger);

  function ensureRuntime() {
    if (tracer) return;
    const rt = getTelemetry();
    hookConfig.tracer = rt.tracer;
    hookConfig.counters = rt.counters;
    hookConfig.histograms = rt.histograms;
    tracer = rt.tracer;
    counters = rt.counters;
    histograms = rt.histograms;
  }

  // Spans created in before_tool_call, completed in tool_result_persist
  const pendingToolSpans = hookConfig.pendingToolSpans;

  // Spans created in llm_input, completed in llm_output
  const pendingLlmSpans = hookConfig.pendingLlmSpans;

  // ==================================================================
  // TYPED HOOKS - registered via api.on() into registry.typedHooks
  // ==================================================================

  // -- message_received ------------------------------------------------
  // Creates the ROOT span for the entire request lifecycle.
  // All subsequent spans (agent, tools) become children of this span.

  const deferredAgentCompletions = new Map<string, DeferredAgentCompletion>();

  function countPendingLlmSpansForSession(runtimeSessionKey: string): number {
    let count = 0;
    for (const pending of pendingLlmSpans.values()) {
      if (pending.runtimeSessionKey === runtimeSessionKey) {
        count += 1;
      }
    }
    return count;
  }

  function finalizeRootSpan(
    sessionCtx: SessionTraceContext | undefined,
    runtimeSessionIdentities: string[],
    runtimeSessionKey: string,
    reason: string
  ): void {
    if (!sessionCtx) {
      return;
    }

    sessionCtx.pendingRootRuntimeSessionIdentities = undefined;
    sessionCtx.rootCompletionDeadlineAt = undefined;

    if (sessionCtx.rootSpan && sessionCtx.rootSpan !== sessionCtx.agentSpan) {
      const totalMs = Date.now() - sessionCtx.startTime;
      sessionCtx.rootSpan.setAttribute("openclaw.request.duration_ms", totalMs);
      sessionCtx.rootSpan.setAttribute("openclaw.request.completion_reason", reason);
      sessionCtx.rootSpan.setStatus({ code: SpanStatusCode.OK });
      captureSpanToCache(
        sessionCtx.rootSpan,
        "openclaw.request",
        "request",
        runtimeSessionKey,
        getSessionId(runtimeSessionKey)
      );
      sessionCtx.rootSpan.end();
    }

    deleteSessionTraceContext(sessionCtx);
    logger.info(
      `[otel] Trace completed for runtimeSession=${runtimeSessionKey} ` +
      `(reason=${reason}, ${formatSessionTraceState(sessionCtx)})`
    );
  }

  function emitOutboundSpan(
    runtimeSessionKey: string,
    channel: string,
    parentContext: Context,
    output: unknown,
    options?: {
      sessionId?: string;
      statusCode?: SpanStatusCode;
      statusMessage?: string;
      signal?: string;
      outcome?: string;
    }
  ): void {
    const span = tracer.startSpan(
      "openclaw.message.sent",
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          [ATTR_OBSERVE_SPAN_KIND]: ObserveSpanKind.WORKFLOW,
          [ATTR_OBSERVE_ENTITY_NAME]: "openclaw.message.sent",
          "openclaw.message.channel": channel,
          "openclaw.message.direction": "outbound",
          "openclaw.session.key": runtimeSessionKey,
          ...(options?.sessionId ? { "session.id": options.sessionId } : {}),
          ...(options?.signal ? { "openclaw.message.delivery_signal": options.signal } : {}),
          ...(options?.outcome ? { "openclaw.message.outcome": options.outcome } : {}),
        },
      },
      parentContext
    );

    if (config.captureContent && output != null) {
      setCapturedContent(span, "output", output, ["openclaw.message"]);
    }

    counters.messagesSent.add(1, {
      "openclaw.message.channel": channel,
    });
    span.setStatus({
      code: options?.statusCode ?? SpanStatusCode.OK,
      ...(options?.statusMessage ? { message: options.statusMessage } : {}),
    });
    captureSpanToCache(
      span,
      "openclaw.message.sent",
      "message",
      runtimeSessionKey,
      options?.sessionId
    );
    span.end();
  }

  function shouldInferOutboundCompletion(sessionCtx: SessionTraceContext): boolean {
    return sessionCtx.messageChannel === "webchat";
  }

  function handleMessageProcessed(evt: MessageProcessedDiagnosticEvent): void {
    try {
      ensureRuntime();
      const sessionCtx = getSessionTraceContextByIdentities(evt.runtimeSessionIdentities);
      logger.info(
        `[otel] message.processed observed: runtimeSession=${evt.runtimeSessionKey}, ` +
        `channel=${evt.channel}, outcome=${evt.outcome}, ${formatSessionTraceState(sessionCtx)}`
      );

      if (!sessionCtx) {
        logger.warn?.(
          `[otel] message.processed observed without active trace context: ` +
          `runtimeSession=${evt.runtimeSessionKey}, channel=${evt.channel}, outcome=${evt.outcome}`
        );
        return;
      }

      if (sessionCtx.messageSentAt) {
        logger.info(
          `[otel] message.processed observed after outbound completion already recorded: ` +
          `runtimeSession=${evt.runtimeSessionKey}, channel=${evt.channel}, outcome=${evt.outcome}`
        );
        return;
      }

      markLifecycleEvent(sessionCtx, "message_processed");
      sessionCtx.messageSentAt = Date.now();

      if (sessionCtx.pendingRootRuntimeSessionIdentities) {
        const sessionId = getSessionId(evt.runtimeSessionKey);
        const parentContext = sessionCtx.rootContext || context.active();
        emitOutboundSpan(
          evt.runtimeSessionKey,
          evt.channel,
          parentContext,
          undefined,
          {
            sessionId,
            signal: "diagnostic.message.processed",
            outcome: evt.outcome,
            statusCode: evt.outcome === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK,
            statusMessage: evt.outcome === "error"
              ? (evt.error || evt.reason || "message processing error")
              : undefined,
          }
        );

        finalizeRootSpan(
          sessionCtx,
          sessionCtx.pendingRootRuntimeSessionIdentities,
          evt.runtimeSessionKey,
          evt.outcome === "error" ? "message_processed_error" : "message_processed"
        );
        return;
      }

      logger.info(
        `[otel] message.processed observed with no pending request root to close: ` +
        `runtimeSession=${evt.runtimeSessionKey}, channel=${evt.channel}, outcome=${evt.outcome}, ` +
        `${formatSessionTraceState(sessionCtx)}`
      );
    } catch (error) {
      logger.debug(`[otel] message.processed observer failed: ${String(error)}`);
    }
  }

  setMessageProcessedObserver(handleMessageProcessed);

  async function finalizeAgentCompletion(completion: DeferredAgentCompletion): Promise<void> {
    const {
      runtimeSessionIdentities,
      runtimeSessionKey,
      agentId,
      durationMs,
      success,
      errorMsg,
      messages,
      diagUsage,
      totalInputTokens,
      totalOutputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      model,
      costUsd,
      sessionCtx,
    } = completion;
    const assistantOutput = extractLatestAssistantOutput(messages);

    if (sessionCtx?.agentSpan) {
      const agentSpan = sessionCtx.agentSpan;

      if (config.captureContent) {
        setCapturedContent(
          agentSpan,
          "output",
          assistantOutput,
          ["openclaw.agent"]
        );
      }

      if (typeof durationMs === "number") {
        agentSpan.setAttribute("openclaw.agent.duration_ms", durationMs);
      }

      agentSpan.setAttribute("gen_ai.usage.input_tokens", totalInputTokens);
      agentSpan.setAttribute("gen_ai.usage.output_tokens", totalOutputTokens);
      agentSpan.setAttribute("gen_ai.usage.total_tokens", totalTokens);
      agentSpan.setAttribute("gen_ai.response.model", model);
      agentSpan.setAttribute("openclaw.agent.success", success);

      if (cacheReadTokens > 0) {
        agentSpan.setAttribute("gen_ai.usage.cache_read_tokens", cacheReadTokens);
      }
      if (cacheWriteTokens > 0) {
        agentSpan.setAttribute("gen_ai.usage.cache_write_tokens", cacheWriteTokens);
      }

      if (typeof costUsd === "number") {
        agentSpan.setAttribute("openclaw.llm.cost_usd", costUsd);
      }

      if (diagUsage?.provider) {
        agentSpan.setAttribute("gen_ai.system", diagUsage.provider);
      }

      if (diagUsage?.context?.limit) {
        agentSpan.setAttribute("openclaw.context.limit", diagUsage.context.limit);
      }
      if (diagUsage?.context?.used) {
        agentSpan.setAttribute("openclaw.context.used", diagUsage.context.used);
      }

      if (!diagUsage && (totalInputTokens > 0 || totalOutputTokens > 0)) {
        const metricAttrs = {
          "gen_ai.response.model": model,
          "gen_ai.agent.id": agentId,
        };
        counters.tokensPrompt.add(totalInputTokens + cacheReadTokens + cacheWriteTokens, metricAttrs);
        counters.tokensCompletion.add(totalOutputTokens, metricAttrs);
        counters.tokensTotal.add(totalTokens, metricAttrs);
        counters.llmRequests.add(1, metricAttrs);
      }

      if (typeof durationMs === "number") {
        histograms.agentTurnDuration.record(durationMs, {
          "gen_ai.response.model": model,
          "gen_ai.agent.id": agentId,
        });
      }

      //if it's in the pending target, compare the context
      //checking if agent was a target of a spawn, and if so, compare its context with the caller's context
      const parentCaller = targetAgentsMap.get(agentId);
      if (parentCaller) {
        const parentContext = pendingAgentContextsMap.get(parentCaller);
        if (parentContext) {
          const output = extractLatestAssistantOutput(messages);
          if (typeof output === "string") {
            const historyString = Array.isArray(parentContext?.historyMessages)
              ? parentContext.historyMessages.map((msg: any) =>
                  typeof msg.content === "string"
                    ? msg.content
                    : msg.content
                      ? JSON.stringify(msg.content)
                      : msg.summary || ""
                ).join(" ")
              : "";

            if (histograms.noveltyScore) {
              const noveltyScore = getNoveltyScore(output, parentContext?.systemPrompt + parentContext?.prompt + historyString);
              histograms.noveltyScore.record(noveltyScore, {
                "gen_ai.agent.id": agentId,
              });
            }
          } else {
            logger.warn(`[otel] Unable to compute novelty score for agent=${agentId} due to non-string output`);
          }
        } else {
          logger.warn(`[otel] No spawn info found for pending spawn target agent=${agentId}`);
        }
        targetAgentsMap.delete(agentId);
      }

      // checking if the agent is still listed in the targetAgentsMap (value), if not, it means the context can be removed
      let foundInTargetMap = false;
      for (const [_, targetValue] of targetAgentsMap.entries()) {
        if (targetValue === agentId + "-" + runtimeSessionKey) {
          foundInTargetMap = true;
          break;
        }
      }
      if (!foundInTargetMap) {
        pendingAgentContextsMap.delete(agentId + "-" + runtimeSessionKey);
      }

      const forkResult = finalizeAgentTurn(runtimeSessionKey);
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

      onAgentEnd(runtimeSessionKey, agentId, agentSpan);
      logger.info(
        `[otel] Agent turn ended: agent=${agentId}, runtimeSession=${runtimeSessionKey}, ` +
        `success=${success}, duration=${durationMs ?? "?"}ms, ` +
        `tokens=${totalTokens}, cost=$${costUsd?.toFixed(4) ?? "?"}`
      );

      if (errorMsg) {
        agentSpan.setAttribute("openclaw.agent.error", String(errorMsg).slice(0, 500));
        agentSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(errorMsg).slice(0, 200) });
      } else {
        agentSpan.setStatus({ code: SpanStatusCode.OK });
      }

      captureSpanToCache(agentSpan, "openclaw.agent.turn", "agent", runtimeSessionKey, getSessionId(runtimeSessionKey));
      agentSpan.end();

      try {
        await getTelemetry().forceFlush();
      } catch {
        // Telemetry runtime already logs flush failures; never block agent cleanup.
      }
    }

    unregisterActiveAgentSpan(runtimeSessionIdentities);
    cleanupHandoff(runtimeSessionKey);
    cleanupForkJoin(runtimeSessionKey);
    // Clear the legacy single-global fallback.
    (globalThis as any).__OPENCLAW_ACTIVE_AGENT_CONTEXT = undefined;

    if (!sessionCtx || sessionCtx.rootSpan === sessionCtx.agentSpan) {
      deleteSessionTraceContext(sessionCtx);
      logger.info(`[otel] Trace completed for runtimeSession=${runtimeSessionKey} (reason=agent_end)`);
      return;
    }

    sessionCtx.agentSpan = undefined;
    sessionCtx.agentContext = undefined;
    sessionCtx.agentId = undefined;
    sessionCtx.latestOutput = assistantOutput;
    sessionCtx.pendingRootRuntimeSessionIdentities = runtimeSessionIdentities;
    sessionCtx.rootCompletionDeadlineAt = Date.now() + ROOT_COMPLETION_GRACE_MS;
    markLifecycleEvent(sessionCtx, "agent_end");

    if (sessionCtx.messageSentAt) {
      finalizeRootSpan(sessionCtx, runtimeSessionIdentities, runtimeSessionKey, "agent_end_after_message_sent");
      return;
    }

    if (shouldInferOutboundCompletion(sessionCtx)) {
      const sessionId = getSessionId(runtimeSessionKey);
      sessionCtx.messageSentAt = Date.now();
      markLifecycleEvent(sessionCtx, "agent_end_inferred_outbound");
      emitOutboundSpan(
        runtimeSessionKey,
        sessionCtx.messageChannel,
        sessionCtx.rootContext || context.active(),
        sessionCtx.latestOutput,
        {
          sessionId,
          signal: "inferred.agent_end.webchat",
          outcome: success ? "ok" : "error",
          statusCode: success ? SpanStatusCode.OK : SpanStatusCode.ERROR,
          statusMessage: success ? undefined : String(errorMsg ?? "agent_end failed").slice(0, 200),
        }
      );
      logger.info(
        `[otel] Inferred outbound completion from agent_end for runtimeSession=${runtimeSessionKey}, ` +
        `channel=${sessionCtx.messageChannel}`
      );
      finalizeRootSpan(
        sessionCtx,
        runtimeSessionIdentities,
        runtimeSessionKey,
        success ? "agent_end_inferred_outbound" : "agent_end_inferred_outbound_error"
      );
      return;
    }

    logger.info(
      `[otel] Request span awaiting outbound completion: runtimeSession=${runtimeSessionKey}, ` +
      `graceMs=${ROOT_COMPLETION_GRACE_MS}, ${formatSessionTraceState(sessionCtx)}`
    );
  }

  api.on(
    "message_received",
    async (event: any, ctx: any) => {
      try {
        ensureRuntime();
        const runtimeSessionKey = resolveRuntimeSessionKey(event, ctx);
        const sessionCtx = getSessionTraceContext(event, ctx);

        // Check for a pre-queued sessions_send handoff BEFORE deciding whether to reuse
        // the existing session context. If a handoff is pending it means this message was
        // routed by sessions_send and we must create a fresh openclaw.request span nested
        // under the send tool span, even when the target agent already has an active session.
        const incomingAgentId = ctx?.agentId || event?.agentId;
        const preQueuedHandoff = incomingAgentId ? peekPendingSpawnHandoff(incomingAgentId) : undefined;

        if (sessionCtx && !preQueuedHandoff) {
          setSessionTraceContext(sessionCtx, event, ctx);
          if (runtimeSessionKey !== "unknown") {
            touchSession(runtimeSessionKey, sessionCtx.rootContext);
          }
          markLifecycleEvent(sessionCtx, "message_received");

          const messageText = extractMessageText(event);
          if (config.captureContent) {
            sessionCtx.latestInput = setCapturedContent(
              sessionCtx.rootSpan,
              "input",
              messageText,
              ["openclaw.request"]
            ) ?? sessionCtx.latestInput;
          }

          if (sessionCtx.pendingRootRuntimeSessionIdentities && !sessionCtx.agentSpan) {
            logger.warn?.(
              `[otel] Closing previous request span before new inbound message: runtimeSession=${sessionCtx.runtimeSessionKey}`
            );
            finalizeRootSpan(
              sessionCtx,
              sessionCtx.pendingRootRuntimeSessionIdentities,
              sessionCtx.runtimeSessionKey,
              "superseded_by_new_message"
            );
          }
        } else {
          // Either new session, or a sessions_send handoff forces a fresh root span.
          // Close any previous pending root first.
          if (sessionCtx?.pendingRootRuntimeSessionIdentities && !sessionCtx.agentSpan) {
            logger.warn?.(
              `[otel] Closing previous request span before ${preQueuedHandoff ? "sessions_send" : "new inbound message"}: runtimeSession=${sessionCtx.runtimeSessionKey}`
            );
            finalizeRootSpan(
              sessionCtx,
              sessionCtx.pendingRootRuntimeSessionIdentities,
              sessionCtx.runtimeSessionKey,
              preQueuedHandoff ? "superseded_by_sessions_send" : "superseded_by_new_message"
            );
          }

          const seed: RootSpanSeed | undefined = preQueuedHandoff
            ? {
                parentContext: preQueuedHandoff.parentContext,
                sessionId: preQueuedHandoff.sourceSessionId,
                // Note: no link to spawnToolSpanContext here — openclaw.request is already a
                // *child* of the tool span (via parentContext), so an explicit link would
                // duplicate the parent relationship and show twice in trace viewers.
                links: [
                  ...(preQueuedHandoff.sourceAgentSpanContext
                    ? [{
                        context: preQueuedHandoff.sourceAgentSpanContext,
                        attributes: {
                          "link.type": "agent_handoff",
                          "ioa_observe.agent.previous": preQueuedHandoff.sourceAgentId,
                          "ioa_observe.agent.previous_sequence": preQueuedHandoff.sourceAgentSequence,
                        },
                      }]
                    : []),
                ],
                attributes: {
                  "openclaw.handoff.source_runtime_session": preQueuedHandoff.sourceRuntimeSessionKey,
                  "openclaw.handoff.source_agent": preQueuedHandoff.sourceAgentId,
                },
              }
            : undefined;
          const startedSessionCtx = startRootSpan(tracer, event, ctx, config, logger, counters, seed);
          markLifecycleEvent(startedSessionCtx, "message_received");
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
        ensureRuntime();
        const runtimeSessionKey = resolveRuntimeSessionKey(event, ctx);
        const sessionCtx = getSessionTraceContext(event, ctx);
        const parentContext = sessionCtx?.rootContext || context.active();
        const channel = event?.channel || ctx?.channelId || event?.metadata?.channelId || "unknown";
        const messageText = extractMessageText(event);
        markLifecycleEvent(sessionCtx, "message_sent");
        logger.info(
          `[otel] message_sent observed: runtimeSession=${runtimeSessionKey}, ` +
          `channel=${channel}, ${formatSessionTraceState(sessionCtx)}`
        );
        const sessionId = runtimeSessionKey !== "unknown"
          ? touchSession(runtimeSessionKey, parentContext)
          : undefined;
        emitOutboundSpan(runtimeSessionKey, channel, parentContext, messageText, {
          sessionId,
          signal: "typed_hook.message_sent",
          outcome: "ok",
        });

        if (sessionCtx) {
          sessionCtx.messageSentAt = Date.now();
          if (sessionCtx.pendingRootRuntimeSessionIdentities) {
            finalizeRootSpan(
              sessionCtx,
              sessionCtx.pendingRootRuntimeSessionIdentities,
              runtimeSessionKey,
              "message_sent"
            );
          } else {
            logger.info(
              `[otel] message_sent observed with no pending request root to close: ` +
              `runtimeSession=${runtimeSessionKey}, ${formatSessionTraceState(sessionCtx)}`
            );
          }
        } else {
          logger.warn?.(
            `[otel] message_sent observed without active trace context: ` +
            `runtimeSession=${runtimeSessionKey}, channel=${channel}`
          );
        }
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
        ensureRuntime();
        const runtimeSessionIdentities = resolveRuntimeSessionIdentities(event, ctx);
        const runtimeSessionKey = runtimeSessionIdentities[0] || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const model = event?.model || "unknown";

        contextPrepTimers.set(agentId, Date.now()); // Would it be possible to have parallel instances of the same agent and same id?

        let sessionCtx = getSessionTraceContext(event, ctx);
        if (sessionCtx?.pendingRootRuntimeSessionIdentities && !sessionCtx.agentSpan) {
          logger.warn?.(
            `[otel] Closing previous request span before agent restart: runtimeSession=${sessionCtx.runtimeSessionKey}, ` +
            `incomingAgent=${agentId}`
          );
          finalizeRootSpan(
            sessionCtx,
            sessionCtx.pendingRootRuntimeSessionIdentities,
            sessionCtx.runtimeSessionKey,
            "superseded_by_new_agent_turn"
          );
          sessionCtx = undefined;
        }

        const pendingSpawnHandoff = consumePendingSpawnHandoff(agentId);
        if (!sessionCtx) {
          const rootSeed: RootSpanSeed | undefined = pendingSpawnHandoff
            ? {
                parentContext: pendingSpawnHandoff.parentContext,
                sessionId: pendingSpawnHandoff.sourceSessionId,
                // Note: no link to spawnToolSpanContext here — openclaw.request is already a
                // *child* of the tool span (via parentContext), so an explicit link would
                // duplicate the parent relationship and show twice in trace viewers.
                links: [
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
                  "openclaw.handoff.source_runtime_session": pendingSpawnHandoff.sourceRuntimeSessionKey,
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
            counters,
            rootSeed
          );
        }

        markLifecycleEvent(sessionCtx, "before_agent_start");

        if (sessionCtx?.agentSpan && sessionCtx.runtimeSessionKey === runtimeSessionKey) {
          const activeAgentId = sessionCtx.agentId || "unknown";
          logger.warn?.(
            `[otel] Duplicate before_agent_start ignored: runtimeSession=${runtimeSessionKey}, ` +
            `activeAgent=${activeAgentId}, incomingAgent=${agentId}`
          );
          return undefined;
        }

        // If this is a different agent running under a shared identity (e.g.
        // same conversationId but different sessionKey), create a fresh context
        // rather than attaching to the existing one.
        if (sessionCtx?.agentSpan && sessionCtx.runtimeSessionKey !== runtimeSessionKey) {
          sessionCtx = undefined;
          if (!sessionContextMap.has(runtimeSessionKey)) {
            sessionCtx = startRootSpan(tracer, event, ctx, config, logger, counters);
          }
        }

        const parentContext = sessionCtx?.rootContext || context.active();
        const sessionId = runtimeSessionKey !== "unknown"
          ? touchSession(runtimeSessionKey, parentContext, undefined, pendingSpawnHandoff?.sourceSessionId)
          : undefined;

        if (pendingSpawnHandoff?.sourceAgentSpanContext) {
          seedHandoffState(runtimeSessionKey, {
            lastAgentSpanContext: pendingSpawnHandoff.sourceAgentSpanContext,
            lastAgentName: pendingSpawnHandoff.sourceAgentId,
            sequence: pendingSpawnHandoff.sourceAgentSequence,
          });
        }

        // Check for join from a previous parallel fork
        const joinInfo = consumeJoin(runtimeSessionKey);
        const joinLinks: Link[] = joinInfo?.links ?? [];
        if (joinInfo) {
          logger.info(
            `[otel] Join detected for agent=${agentId}: forkId=${joinInfo.attributes["ioa_observe.join.fork_id"]}, ` +
            `branches=${joinInfo.attributes["ioa_observe.join.branch_count"]}`
          );
        }

        // Prepare handoff links before span creation so OTel records them.
        const handoff = onAgentStart(runtimeSessionKey, agentId);
        // When this agent was merged into another session via sessions_send, add a link
        // from the agent turn back to the agent's own previous root span.
        const sessionMergeLinks: Link[] = sessionCtx?.previousSessionStartSpanContext
          ? [{ context: sessionCtx.previousSessionStartSpanContext, attributes: { "link.type": "session_merge" } }]
          : [];
        const agentLinks: Link[] = [...joinLinks, ...handoff.links, ...sessionMergeLinks];

        // Create agent turn span as child of root span
        const agentSpan = tracer.startSpan(
          "openclaw.agent.turn",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              [ATTR_OBSERVE_SPAN_KIND]: ObserveSpanKind.AGENT,
              [ATTR_OBSERVE_ENTITY_NAME]: agentId,
              [GEN_AI_OPERATION_NAME_ATTR]: GEN_AI_OPERATION.INVOKE_AGENT,
              "gen_ai.agent.id": agentId,
              [GEN_AI_AGENT_NAME_ATTR]: agentId,
              "openclaw.session.key": runtimeSessionKey,
              ...(runtimeSessionKey !== "unknown" ? { [GEN_AI_CONVERSATION_ID_ATTR]: runtimeSessionKey } : {}),
              ...(sessionId ? { "session.id": sessionId } : {}),
              "gen_ai.agent.model": model,
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

        registerAgentSpan(runtimeSessionKey, agentId, agentSpan, handoff.sequence, handoff.previousAgentName);
        if (handoff.links.length > 0) {
          logger.debug(
            `[otel] Handoff links prepared for agent=${agentId}: ${handoff.links.length} link(s), ` +
            `seq=${handoff.attributes["ioa_observe.agent.sequence"]}, ` +
            `previous=${handoff.attributes["ioa_observe.agent.previous"] || "(none)"}`
          );
        }

        const agentContext = trace.setSpan(parentContext, agentSpan);

        // Store the agent context so llm_input can call enterWith() in the
        // correct async execution context (the one that actually makes the
        // LLM call). before_agent_start fires in a separate async chain from
        // the LLM call, so enterWith() here would not propagate.
        // Legacy single-global fallback for runtimes without preload.mjs.
        (globalThis as any).__OPENCLAW_ACTIVE_AGENT_CONTEXT = agentContext;

        // Store agent span context for tool spans
        if (sessionCtx) {
          setSessionTraceContext(sessionCtx, event, ctx);
          sessionCtx.agentSpan = agentSpan;
          sessionCtx.agentContext = agentContext;
          sessionCtx.agentId = agentId;
        } else if (runtimeSessionKey !== "unknown") {
          setSessionTraceContext({
            runtimeSessionKey,
            messageChannel: event?.channel || ctx?.channelId || event?.metadata?.channelId || "unknown",
            rootSpan: agentSpan,
            rootContext: agentContext,
            agentSpan,
            agentContext,
            agentId,
            startTime: Date.now(),
          }, event, ctx);
        }

        // Register in activeAgentSpans for diagnostics integration
        registerActiveAgentSpan(runtimeSessionIdentities, agentSpan);

        logger.info?.(`[otel] Agent turn started: agent=${agentId}, model=${model}, runtimeSession=${runtimeSessionKey}`);
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
    (_event: any, _ctx: any) => {
      // Not implemented at the moment
      return undefined;
    }
  );
 logger.info("[otel] Registered before_model_resolve hook (via api.on)");
  api.on(
    "before_prompt_build",
    (_event: any, _ctx: any) => {
      // Not implemented at the moment
      return undefined;
    }
  );
  logger.info("[otel] Registered before_prompt_build hook (via api.on)");

  // ── llm_input ────────────────────────────────────────────────────
  // Creates an LLM call span at the moment the request is sent to the model.
  // The span is stored in pendingLlmSpans and closed in llm_output once the
  // response is available.
  // SYNCHRONOUS — must not return a Promise.

  api.on(
    "llm_input",
    (event: any, ctx: any) => {
      try {
        ensureRuntime();
        const runtimeSessionKey = resolveRuntimeSessionKey(event, ctx);
        const agentId = ctx?.agentId || event?.agentId || "unknown";
        const model = event?.model || ctx?.model || "unknown";
        const callId = event?.callId || event?.requestId || runtimeSessionKey;

        const sessionCtx = getSessionTraceContext(event, ctx);
        const parentContext = sessionCtx?.agentContext || sessionCtx?.rootContext || context.active();
        const sessionId = runtimeSessionKey !== "unknown"
          ? touchSession(runtimeSessionKey, parentContext)
          : undefined;

        const startTime = contextPrepTimers.get(agentId);
        if (startTime) {
          const tpc = Date.now() - startTime;
          contextPrepTimers.delete(agentId); // Cleanup
          histograms.contextPreparationDuration.record(tpc, {
            "gen_ai.agent.id": agentId,
          });
        } else {
          logger.warn?.(`[otel] No start time found for agent=${agentId} in llm_input hook — cannot record context preparation time`);
        }
        const span = tracer.startSpan(
          "openclaw.llm.call",
          {
            kind: SpanKind.CLIENT,
            attributes: {
              [ATTR_OBSERVE_SPAN_KIND]: ObserveSpanKind.TASK,
              [ATTR_OBSERVE_ENTITY_NAME]: "openclaw.llm.call",
              "openclaw.session.key": runtimeSessionKey,
              ...(sessionId ? { "session.id": sessionId } : {}),
              "gen_ai.agent.id": agentId,
              "gen_ai.request.model": model,
            },
          },
          parentContext
        );

        // Capture the messages / prompt sent to the model
        const messages = event?.messages || event?.prompt || event?.input;
        if (config.captureContent && messages != null) {
          setCapturedContent(span, "input", messages, ["openclaw.llm"]);
        }
        pendingLlmSpans.set(callId, {
          span,
          runtimeSessionKey,
          agentId,
        });
        logger.info?.(`[otel] LLM span started: model=${model}, callId=${callId}, runtimeSession=${runtimeSessionKey}`);
        parseContext(event, histograms, sessionId, agentId);
        pendingAgentContextsMap.set(agentId+"-"+runtimeSessionKey, event);

        const parentCaller = targetAgentsMap.get(agentId);
        if (parentCaller) {
          const parentContext = pendingAgentContextsMap.get(parentCaller);
          if (parentContext) {
            const historyString = Array.isArray(parentContext?.historyMessages)
              ? parentContext.historyMessages.map((msg: any) =>
                typeof msg.content === "string"
                  ? msg.content
                  : msg.content
                    ? JSON.stringify(msg.content)
                    : msg.summary || ""
              ).join(" ")
              : "";
            const noveltyScore = calculateCoverage(event.prompt, parentContext?.systemPrompt + parentContext?.prompt + historyString);
            if (histograms.downstreamContextSharing) {
              histograms.downstreamContextSharing.record(noveltyScore, {
                "gen_ai.agent.id": agentId,
              });
            }
          } else {
            logger.warn(`[otel] Unable to compute downstreamContextSharing for agent=${agentId} because parent context is missing for parentCaller=${parentCaller}`);
          }
        }

        // llm_input is SYNCHRONOUS and fires in the same async execution frame
        // as the actual anthropic/openai messages.create() call that follows.
        // enterWith() here correctly propagates the agent context into the
        // Promise chain created by messages.create(), so OpenLLMetry's
        // auto-instrumented span picks up the right parentSpanId even when
        // multiple agents run in parallel (each agent's LLM call has its own
        // executionAsyncId, so there is no cross-agent interference).
        const agentContextStore = (globalThis as any).__OPENCLAW_AGENT_CONTEXT_STORE;
        if (agentContextStore && sessionCtx?.agentContext) {
          agentContextStore.enterWith(sessionCtx.agentContext);
        }
      } catch {
        // Never let telemetry errors break the main flow
      }
      return undefined;
    }
  );

  logger.info("[otel] Registered llm_input hook (via api.on)");

  // ── llm_output ───────────────────────────────────────────────────
  // Looks up the span created in llm_input, attaches output and token
  // usage metadata, then closes the span.
  // SYNCHRONOUS — must not return a Promise.

  api.on(
    "llm_output",
    (event: any, ctx: any) => {
      try {
        const runtimeSessionKey = resolveRuntimeSessionKey(event, ctx);
        const agentId = ctx?.agentId || event?.agentId || "unknown";
        const callId = event?.callId || event?.requestId || runtimeSessionKey;

        const pendingLlm = pendingLlmSpans.get(callId);
        if (!pendingLlm) {
          logger.warn?.(`[otel] No pending LLM span for callId=${callId} — skipping output capture`);
          return undefined;
        }
        pendingLlmSpans.delete(callId);
        const { span, runtimeSessionKey: pendingRuntimeSessionKey } = pendingLlm;

        // Token usage
        const usage = event?.usage;
        if (usage) {
          const inputTokens =
            usage.input ?? usage.inputTokens ?? usage.input_tokens ?? 0;
          const outputTokens =
            usage.output ?? usage.outputTokens ?? usage.output_tokens ?? 0;
          const cacheRead = usage.cacheRead ?? usage.cache_read_tokens ?? 0;
          const cacheWrite = usage.cacheWrite ?? usage.cache_write_tokens ?? 0;

          span.setAttribute("gen_ai.usage.input_tokens", inputTokens);
          span.setAttribute("gen_ai.usage.output_tokens", outputTokens);
          span.setAttribute("gen_ai.usage.total_tokens", inputTokens + outputTokens + cacheRead + cacheWrite);
          if (cacheRead > 0) span.setAttribute("gen_ai.usage.cache_read_tokens", cacheRead);
          if (cacheWrite > 0) span.setAttribute("gen_ai.usage.cache_write_tokens", cacheWrite);
        }

        const model = event?.model || ctx?.model;
        if (model) {
          span.setAttribute("gen_ai.response.model", String(model));
        }

        // Capture the model response
        const output = event?.output || event?.response || event?.completion || event?.message;
        if (config.captureContent && output != null) {
          setCapturedContent(span, "output", output, ["openclaw.llm"]);
        }

        if (event?.error) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(event.error).slice(0, 200) });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        captureSpanToCache(
          span,
          "openclaw.llm.call",
          "llm",
          pendingRuntimeSessionKey,
          getSessionId(pendingRuntimeSessionKey)
        );
        span.end();
        logger.info?.(`[otel] LLM span ended: callId=${callId}, agent=${agentId}, runtimeSession=${pendingRuntimeSessionKey}`);

        const deferredCompletion = deferredAgentCompletions.get(pendingRuntimeSessionKey);
        if (deferredCompletion && countPendingLlmSpansForSession(pendingRuntimeSessionKey) === 0) {
          deferredAgentCompletions.delete(pendingRuntimeSessionKey);
          logger.info(
            `[otel] Completing deferred trace finalization for runtimeSession=${pendingRuntimeSessionKey} after final llm_output`
          );
          void finalizeAgentCompletion(deferredCompletion);
        }
      } catch {
        // Never let telemetry errors break the main flow
      }
      return undefined;
    }
  );

  logger.info("[otel] Registered llm_output hook (via api.on)");

  // ── before_tool_call ─────────────────────────────────────────────
  // Creates the tool span at call time, capturing input and running security
  // checks. The span is stored in pendingToolSpans and closed in
  // tool_result_persist once the output is available.
  // SYNCHRONOUS — must not return a Promise.

  api.on(
    "before_tool_call",
    (event: any, ctx: any) => {
      try {
        ensureRuntime();
        const toolName = event?.toolName || event?.name || "unknown";
        const toolCallId = event?.toolCallId || event?.id || "";
        const isSynthetic = event?.isSynthetic === true;
        const runtimeSessionKey = resolveRuntimeSessionKey(event, ctx);
        const agentId = ctx?.agentId || "unknown";

        // Tool input is available in event.input for security checks
        const toolInput = event?.input || event?.params || event?.toolInput || event?.args || {};

        // Record metric
        counters.toolCalls.add(1, {
          "tool.name": toolName,
          "gen_ai.agent.id": agentId,
        });

        // Get parent context - prefer agent turn span, fall back to root
        const sessionCtx = getSessionTraceContext(event, ctx);
        const parentContext = sessionCtx?.agentContext || sessionCtx?.rootContext || context.active();
        const sessionId = runtimeSessionKey !== "unknown"
          ? touchSession(runtimeSessionKey, parentContext)
          : undefined;

        // Create tool span as child of agent turn
        const span = tracer.startSpan(
          `tool.${toolName}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              [ATTR_OBSERVE_SPAN_KIND]: ObserveSpanKind.TOOL,
              [ATTR_OBSERVE_ENTITY_NAME]: toolName,
              [GEN_AI_OPERATION_NAME_ATTR]: GEN_AI_OPERATION.EXECUTE_TOOL,
              [GEN_AI_TOOL_NAME_ATTR]: toolName,
              "openclaw.tool.name": toolName,
              ...(toolCallId ? { [GEN_AI_TOOL_CALL_ID_ATTR]: toolCallId } : {}),
              "openclaw.tool.call_id": toolCallId,
              "openclaw.tool.is_synthetic": isSynthetic,
              "openclaw.session.key": runtimeSessionKey,
              ...(runtimeSessionKey !== "unknown" ? { [GEN_AI_CONVERSATION_ID_ATTR]: runtimeSessionKey } : {}),
              ...(sessionId ? { "session.id": sessionId } : {}),
              "gen_ai.agent.id": agentId,
            },
          },
          parentContext
        );

        // Fork detection - register this tool span for parallel detection
        const agentSequence = getHandoffSequence(runtimeSessionKey);
        const forkAttrs = registerToolSpan(runtimeSessionKey, toolName, span, agentId, agentSequence);
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

        // Store span so tool_result_persist can add the output and close it
        if (toolCallId) {
          pendingToolSpans.set(toolCallId, {
            span,
            startedAt: Date.now(),
          });
        } else {
          // No toolCallId to key on — close immediately with no output
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        }

        // For sessions_send, pre-queue the handoff NOW (before the tool executes and
        // the target agent's message_received fires) so the root span can be correctly
        // parented under this tool span. sessions_spawn is handled post-result in
        // handleToolOutput because the target agent ID comes from the result.
        if (toolName === "sessions_send") {
          const sendTargetIds = extractSpawnTargetAgentIds(toolInput, {});
          if (sendTargetIds.length > 0) {
            const sourceAgentSpanContext = sessionCtx?.agentSpan?.spanContext();
            for (const targetAgentId of sendTargetIds) {
              queuePendingSpawnHandoff({
                targetAgentId,
                sourceRuntimeSessionKey: runtimeSessionKey,
                sourceSessionId: getSessionId(runtimeSessionKey),
                sourceAgentId: agentId,
                sourceAgentSequence: agentSequence,
                sourceAgentSpanContext,
                spawnToolSpanContext: span.spanContext(),
                parentContext: trace.setSpan(parentContext, span),
                linkType: "agent_send",
                createdAt: Date.now(),
              });
              targetAgentsMap.set(targetAgentId, agentId + "-" + runtimeSessionKey);
            }
            logger.info?.(
              `[otel] Pre-queued sessions_send handoff to [${sendTargetIds.join(", ")}], ` +
              `runtimeSession=${runtimeSessionKey}`
            );
          }
        }

        logger.info?.(`[otel] Tool span started: tool=${toolName}, callId=${toolCallId}, runtimeSession=${runtimeSessionKey}`);
      } catch {
        // Never let telemetry errors break the main flow
      }
      return undefined;
    }
  );

    // ── after_tool_call ──────────────────────────────────────────
    // Looks up the span created in before_tool_call, attaches output metadata,
    // and closes the span.
    // SYNCHRONOUS — must not return a Promise.

    api.on(
    "after_tool_call",
    (event: any, ctx: any) => {
      try {
        ensureRuntime();
        handleToolOutput(event, ctx, hookConfig);
      } catch (error) {
        // Never let telemetry errors break the main flow
        logger.error(`[otel] after_tool_call hook failed: ${String(error)}`);
      }
      // Return undefined to keep the tool result unchanged
      return undefined;
    },
    { priority: -100 }
  );

  logger.info("[otel] Registered after_tool_call hook (via api.on)");

  // ── tool_result_persist ──────────────────────────────────────────
  // Looks up the span created in before_tool_call, attaches output metadata,
  // and closes the span.
  // SYNCHRONOUS — must not return a Promise.

  api.on(
    "tool_result_persist",
    (event: any, ctx: any) => {
      try {
        ensureRuntime();
        handleToolOutput(event, ctx, hookConfig);
      } catch (error) {
        logger.error(`[otel] tool_result_persist hook failed: ${String(error)}`);
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
        ensureRuntime();
        const runtimeSessionIdentities = resolveRuntimeSessionIdentities(event, ctx);
        const runtimeSessionKey = runtimeSessionIdentities[0] || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const durationMs = event?.durationMs;
        const success = event?.success !== false;
        const errorMsg = event?.error;

        // Try to get usage from diagnostic events (includes cost!)
        const diagUsage = getPendingUsage(runtimeSessionIdentities);

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
              const usage = normalizeUsageData(msg.usage);
              totalInputTokens += usage.input || 0;
              totalOutputTokens += usage.output || 0;
              cacheReadTokens += usage.cacheRead || 0;
              cacheWriteTokens += usage.cacheWrite || 0;
            }
            if (msg?.role === "assistant") {
              model = msg.model || msg.modelName || model;
            }
          }
        }

        const totalTokens = totalInputTokens + totalOutputTokens + cacheReadTokens + cacheWriteTokens;
        logger.debug(`[otel] agent_end tokens: input=${totalInputTokens}, output=${totalOutputTokens}, cache_read=${cacheReadTokens}, cache_write=${cacheWriteTokens}, model=${model}`);

        const sessionCtx = getSessionTraceContext(event, ctx);
        const pendingLlmCount = countPendingLlmSpansForSession(runtimeSessionKey);
        const completion: DeferredAgentCompletion = {
          runtimeSessionIdentities,
          runtimeSessionKey,
          agentId,
          durationMs,
          success,
          errorMsg,
          messages,
          diagUsage,
          totalInputTokens,
          totalOutputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          totalTokens,
          model,
          costUsd,
          sessionCtx,
        };

        if (pendingLlmCount > 0) {
          deferredAgentCompletions.set(runtimeSessionKey, completion);

          logger.info(
            `[otel] Deferring trace completion for runtimeSession=${runtimeSessionKey} until ${pendingLlmCount} pending llm span(s) close`
          );
          return undefined;
        }

        await finalizeAgentCompletion(completion);
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
        ensureRuntime();
        const action = event?.action || "unknown";
        const runtimeSessionKey = event?.sessionKey || "unknown";

        // Get parent context if available
        const sessionCtx = sessionContextMap.get(runtimeSessionKey);
        const parentContext = sessionCtx?.rootContext || context.active();
        const sessionAttrs = getSessionIdAttrs(runtimeSessionKey);

        const span = tracer.startSpan(
          `openclaw.command.${action}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "openclaw.command.action": action,
              "openclaw.command.runtime_session_key": runtimeSessionKey,
              ...sessionAttrs,
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
          endSession(runtimeSessionKey, histograms);
          logger.info(`[otel] Session ended via command:${action}: runtimeSession=${runtimeSessionKey}`);
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
    async (_event: any) => {
      try {
        ensureRuntime();
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
  // Safety net: clean up stale runtime-session contexts (e.g., if agent_end never fires)
  setInterval(() => {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes
    const seen = new Set<SessionTraceContext>();
    for (const [, ctx] of sessionContextMap) {
      if (seen.has(ctx)) {
        continue;
      }
      seen.add(ctx);

      if (
        ctx.pendingRootRuntimeSessionIdentities &&
        ctx.rootCompletionDeadlineAt != null &&
        now >= ctx.rootCompletionDeadlineAt
      ) {
        logger.warn?.(
          `[otel] Request span timed out waiting for outbound completion: runtimeSession=${ctx.runtimeSessionKey}, ` +
          `graceMs=${ROOT_COMPLETION_GRACE_MS}, ${formatSessionTraceState(ctx)}`
        );
        finalizeRootSpan(
          ctx,
          ctx.pendingRootRuntimeSessionIdentities,
          ctx.runtimeSessionKey,
          "timeout_waiting_for_outbound_completion"
        );
        continue;
      }

      if (now - ctx.startTime > maxAge) {
        try {
          for (const [callId, pendingLlm] of pendingLlmSpans) {
            if (pendingLlm.runtimeSessionKey !== ctx.runtimeSessionKey) {
              continue;
            }
            pendingLlmSpans.delete(callId);
            pendingLlm.span.setStatus({ code: SpanStatusCode.ERROR, message: "LLM span timed out during stale cleanup" });
            captureSpanToCache(
              pendingLlm.span,
              "openclaw.llm.call",
              "llm",
              pendingLlm.runtimeSessionKey,
              getSessionId(pendingLlm.runtimeSessionKey)
            );
            pendingLlm.span.end();
          }
          deferredAgentCompletions.delete(ctx.runtimeSessionKey);
          ctx.agentSpan?.end();
          if (ctx.rootSpan !== ctx.agentSpan) ctx.rootSpan?.end();
        } catch { /* ignore */ }
        deleteSessionTraceContext(ctx);
        unregisterActiveAgentSpan([ctx.runtimeSessionKey]);
        cleanupHandoff(ctx.runtimeSessionKey);
        cleanupForkJoin(ctx.runtimeSessionKey);
        logger.debug(`[otel] Cleaned up stale trace context for runtimeSession=${ctx.runtimeSessionKey}`);
      }
    }
  }, 60_000).unref();
}

export default registerHooks;
