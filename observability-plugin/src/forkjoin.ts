/**
 * Fork/Join Detection — identifies parallel agent/tool invocations.
 *
 * Ported from agntcy/observe SDK concepts:
 *   - When multiple tools fire under the same agent span within a time window,
 *     they are marked as a fork group
 *   - The next agent span after a fork group is annotated as the "join" point
 *   - Fork branches get: ioa_observe.fork.id, ioa_observe.fork.branch_index
 *   - Join spans get: ioa_observe.join.fork_id, ioa_observe.join.branch_count
 *
 * Detection approach:
 *   Tool spans arriving for the same (sessionKey, agentSpanId) are grouped.
 *   If >1 tool spans arrive within FORK_WINDOW_MS, they form a fork group.
 *   The fork is finalized when agent_end fires or the window expires.
 */

import { randomBytes } from "crypto";
import type { Span, SpanContext, Link } from "@opentelemetry/api";

// ── Logger ─────────────────────────────────────────────────────────

let loggerRef: any = null;

/** Set module-level logger (called once during plugin init) */
export function setForkJoinLogger(logger: any): void {
  loggerRef = logger;
}

// ── Configuration ──────────────────────────────────────────────────

/** Time window (ms) within which concurrent tool calls are considered a fork */
const FORK_WINDOW_MS = 2000;

// ── Types ──────────────────────────────────────────────────────────

interface ToolEntry {
  span: Span;
  spanContext: SpanContext;
  toolName: string;
  timestamp: number;
}

interface ForkGroup {
  forkId: string;
  parentAgentName: string;
  parentSequence: number;
  tools: ToolEntry[];
  firstTimestamp: number;
}

/** Pending tool spans for the current agent turn, keyed by sessionKey */
const pendingTools = new Map<string, ForkGroup>();

/** Completed fork groups waiting for a join, keyed by sessionKey */
const completedForks = new Map<string, ForkGroup>();

// ── Public API ─────────────────────────────────────────────────────

/**
 * Register a tool span for fork detection.
 * Called from tool_result_persist hook AFTER the span is created.
 * Returns fork attributes to set on the tool span (if part of a fork).
 */
export function registerToolSpan(
  sessionKey: string,
  toolName: string,
  span: Span,
  agentName: string,
  agentSequence: number
): Record<string, string | number> | null {
  const now = Date.now();
  const existing = pendingTools.get(sessionKey);

  if (existing && now - existing.firstTimestamp <= FORK_WINDOW_MS) {
    // Add to existing fork group
    const branchIndex = existing.tools.length;
    existing.tools.push({
      span,
      spanContext: span.spanContext(),
      toolName,
      timestamp: now,
    });

    // Retroactively annotate the first tool if this is the second
    if (existing.tools.length === 2) {
      const first = existing.tools[0];
      first.span.setAttribute("ioa_observe.fork.id", existing.forkId);
      first.span.setAttribute("ioa_observe.fork.branch_index", 0);
      first.span.setAttribute("ioa_observe.fork.parent_name", agentName);
      first.span.setAttribute("ioa_observe.fork.parent_sequence", agentSequence);
      loggerRef?.info && loggerRef.info(
        `[otel:forkjoin] Fork group detected: session=${sessionKey}, forkId=${existing.forkId}, ` +
        `branch[0]=${first.toolName}, branch[1]=${toolName} (window=${now - existing.firstTimestamp}ms)`
      );
    } else {
      loggerRef?.debug && loggerRef.debug(
        `[otel:forkjoin] Fork branch added: session=${sessionKey}, forkId=${existing.forkId}, ` +
        `branch[${branchIndex}]=${toolName}, total=${existing.tools.length}`
      );
    }

    return {
      "ioa_observe.fork.id": existing.forkId,
      "ioa_observe.fork.branch_index": branchIndex,
      "ioa_observe.fork.parent_name": agentName,
      "ioa_observe.fork.parent_sequence": agentSequence,
    };
  }

  // Start new potential fork group
  const forkId = randomBytes(8).toString("hex");
  pendingTools.set(sessionKey, {
    forkId,
    parentAgentName: agentName,
    parentSequence: agentSequence,
    tools: [{
      span,
      spanContext: span.spanContext(),
      toolName,
      timestamp: now,
    }],
    firstTimestamp: now,
  });

  loggerRef?.debug && loggerRef.debug(
    `[otel:forkjoin] New tool registered (potential fork): session=${sessionKey}, ` +
    `tool=${toolName}, candidateForkId=${forkId}`
  );

  // Single tool — no fork attributes yet (will be set retroactively if more arrive)
  return null;
}

/**
 * Finalize fork detection for a session's agent turn.
 * Called from agent_end hook.
 * Returns join metadata if a fork group was detected.
 */
export function finalizeAgentTurn(
  sessionKey: string
): { forkId: string; branchCount: number; branchLinks: Link[] } | null {
  const group = pendingTools.get(sessionKey);
  pendingTools.delete(sessionKey);

  if (!group || group.tools.length < 2) {
    loggerRef?.debug && loggerRef.debug(
      `[otel:forkjoin] Agent turn finalized: session=${sessionKey}, ` +
      `tools=${group?.tools.length ?? 0} (no fork — need ≥2 concurrent tools)`
    );
    return null; // No fork detected (0 or 1 tool)
  }

  // Store completed fork for potential join annotation on next agent
  completedForks.set(sessionKey, group);

  loggerRef?.info && loggerRef.info(
    `[otel:forkjoin] Fork group finalized: session=${sessionKey}, forkId=${group.forkId}, ` +
    `branches=${group.tools.length} [${group.tools.map(t => t.toolName).join(", ")}]`
  );
  loggerRef?.debug && loggerRef.debug(
    `[otel:forkjoin]   awaiting join from next agent`
  );

  return {
    forkId: group.forkId,
    branchCount: group.tools.length,
    branchLinks: group.tools.map((t) => ({
      context: t.spanContext,
      attributes: {
        "link.type": "fork_branch",
        "ioa_observe.fork.tool_name": t.toolName,
      },
    })),
  };
}

/**
 * Check if there is a completed fork group waiting for a join.
 * Called from before_agent_start to annotate the joining agent.
 * Returns join attributes and links, then clears the completed fork.
 */
export function consumeJoin(
  sessionKey: string
): { attributes: Record<string, string | number>; links: Link[] } | null {
  const group = completedForks.get(sessionKey);
  if (!group) return null;

  completedForks.delete(sessionKey);

  loggerRef?.info && loggerRef.info(
    `[otel:forkjoin] Join consumed: session=${sessionKey}, forkId=${group.forkId}, ` +
    `joining ${group.tools.length} branches [${group.tools.map(t => t.toolName).join(", ")}]`
  );

  return {
    attributes: {
      "ioa_observe.join.fork_id": group.forkId,
      "ioa_observe.join.branch_count": group.tools.length,
    },
    links: group.tools.map((t) => ({
      context: t.spanContext,
      attributes: {
        "link.type": "join_branch",
        "ioa_observe.fork.tool_name": t.toolName,
      },
    })),
  };
}

/**
 * Clean up fork/join state for a session.
 */
export function cleanupForkJoin(sessionKey: string): void {
  const hadPending = pendingTools.has(sessionKey);
  const hadCompleted = completedForks.has(sessionKey);
  pendingTools.delete(sessionKey);
  completedForks.delete(sessionKey);
  if (hadPending || hadCompleted) {
    loggerRef?.debug && loggerRef.debug(
      `[otel:forkjoin] Cleaned up fork/join state: session=${sessionKey}, ` +
      `hadPending=${hadPending}, hadCompleted=${hadCompleted}`
    );
  }
}
