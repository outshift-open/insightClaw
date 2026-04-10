/**
 * Cross-Process Context Propagation — header inject/extract utilities.
 *
 * Ported from agntcy/observe SDK (context_utils.py):
 *   - get_current_context_headers() → getContextHeaders()
 *   - set_context_from_headers()    → setContextFromHeaders()
 *
 * These propagate W3C trace context + AGNTCY agent handoff metadata
 * across process boundaries (HTTP, MCP, etc.).
 *
 * Headers propagated:
 *   - traceparent          — W3C trace context
 *   - baggage              — W3C baggage
 *   - x-session-id         — Session identifier
 *   - x-last-agent-span-id — Span ID of the previously executing agent
 *   - x-last-agent-trace-id— Trace ID of the previously executing agent
 *   - x-last-agent-name    — Name of the previously executing agent
 *   - x-agent-sequence     — Position in the agent execution chain
 *   - x-fork-id            — Fork group ID (for parallel execution)
 *   - x-fork-parent-seq    — Fork parent sequence
 *   - x-fork-branch-index  — Branch index within a fork group
 */

import {
  context,
  trace,
  propagation,
  type SpanContext,
} from "@opentelemetry/api";

// ── Header Names ───────────────────────────────────────────────────

export const HEADER_SESSION_ID = "x-session-id";
export const HEADER_LAST_AGENT_SPAN_ID = "x-last-agent-span-id";
export const HEADER_LAST_AGENT_TRACE_ID = "x-last-agent-trace-id";
export const HEADER_LAST_AGENT_NAME = "x-last-agent-name";
export const HEADER_AGENT_SEQUENCE = "x-agent-sequence";
export const HEADER_FORK_ID = "x-fork-id";
export const HEADER_FORK_PARENT_SEQ = "x-fork-parent-seq";
export const HEADER_FORK_BRANCH_INDEX = "x-fork-branch-index";

// ── Types ──────────────────────────────────────────────────────────

export interface AgentContextHeaders {
  [key: string]: string;
}

export interface AgentLinkingInfo {
  lastAgentSpanId?: string;
  lastAgentTraceId?: string;
  lastAgentName?: string;
  agentSequence?: number;
  sessionId?: string;
  forkId?: string;
  forkParentSeq?: number;
  forkBranchIndex?: number;
}

// ── Inject (Sender Side) ──────────────────────────────────────────

/**
 * Get headers containing the current trace context and agent linking info.
 * Call this on the sender side before making an HTTP/MCP request to another agent.
 */
export function getContextHeaders(
  sessionId?: string,
  agentLinking?: {
    lastAgentName?: string;
    lastAgentSpanContext?: SpanContext;
    agentSequence?: number;
    forkId?: string;
    forkParentSeq?: number;
    forkBranchIndex?: number;
  }
): AgentContextHeaders {
  const headers: AgentContextHeaders = {};

  // Inject W3C trace context (traceparent + baggage)
  propagation.inject(context.active(), headers);

  // Session ID
  if (sessionId) {
    headers[HEADER_SESSION_ID] = sessionId;
  }

  // Agent linking metadata
  if (agentLinking) {
    const spanCtx = agentLinking.lastAgentSpanContext;
    if (spanCtx) {
      headers[HEADER_LAST_AGENT_SPAN_ID] = spanCtx.spanId;
      headers[HEADER_LAST_AGENT_TRACE_ID] = spanCtx.traceId;
    }
    if (agentLinking.lastAgentName) {
      headers[HEADER_LAST_AGENT_NAME] = agentLinking.lastAgentName;
    }
    if (agentLinking.agentSequence !== undefined) {
      headers[HEADER_AGENT_SEQUENCE] = String(agentLinking.agentSequence);
    }
    if (agentLinking.forkId) {
      headers[HEADER_FORK_ID] = agentLinking.forkId;
    }
    if (agentLinking.forkParentSeq !== undefined) {
      headers[HEADER_FORK_PARENT_SEQ] = String(agentLinking.forkParentSeq);
    }
    if (agentLinking.forkBranchIndex !== undefined) {
      headers[HEADER_FORK_BRANCH_INDEX] = String(agentLinking.forkBranchIndex);
    }
  }

  return headers;
}

// ── Extract (Receiver Side) ───────────────────────────────────────

/**
 * Extract agent linking info from incoming headers.
 * Call this on the receiver side to restore trace context and agent linking.
 * Returns the extracted context and linking info.
 */
export function extractContextFromHeaders(
  headers: Record<string, string | string[] | undefined>
): AgentLinkingInfo {
  const get = (key: string): string | undefined => {
    const val = headers[key];
    if (Array.isArray(val)) return val[0];
    return val ?? undefined;
  };

  // Restore W3C trace context into the OTel context
  propagation.extract(context.active(), headers);

  const seqStr = get(HEADER_AGENT_SEQUENCE);
  const forkParentStr = get(HEADER_FORK_PARENT_SEQ);
  const forkBranchStr = get(HEADER_FORK_BRANCH_INDEX);

  return {
    sessionId: get(HEADER_SESSION_ID),
    lastAgentSpanId: get(HEADER_LAST_AGENT_SPAN_ID),
    lastAgentTraceId: get(HEADER_LAST_AGENT_TRACE_ID),
    lastAgentName: get(HEADER_LAST_AGENT_NAME),
    agentSequence: seqStr ? parseInt(seqStr, 10) : undefined,
    forkId: get(HEADER_FORK_ID),
    forkParentSeq: forkParentStr ? parseInt(forkParentStr, 10) : undefined,
    forkBranchIndex: forkBranchStr ? parseInt(forkBranchStr, 10) : undefined,
  };
}
