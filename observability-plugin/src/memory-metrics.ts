import { type Span, SpanStatusCode } from "@opentelemetry/api";

import { getBySessionKey } from "./span-cache.js";
import type { OtelCounters, OtelHistograms } from "./telemetry.js";

export type MemoryOperation = "read" | "write" | "edit" | "search";

type MemoryCounters = Pick<
  OtelCounters,
  "memoryReadEvents" | "memoryWriteEvents" | "memoryEditEvents" | "memorySearchMiss" | "memorySearchHit"
>;

type MemoryHistograms = Pick<
  OtelHistograms,
  | "memoryFailureRate"
  | "memorySearchFragmentation"
  | "memoryReadDuration"
  | "memoryWriteDuration"
  | "memoryEditDuration"
>;

interface MemoryMetricLogger {
  info?: (message: string) => void;
}

interface RecordMemoryToolMetricsParams {
  toolName: string;
  toolInput: unknown;
  counters: MemoryCounters;
  histograms: MemoryHistograms;
  message: any;
  durationMs: number;
  agentId: string;
}

interface RecordMemoryFailureRateParams {
  histograms: MemoryHistograms;
  runtimeSessionKey: string;
  logger?: MemoryMetricLogger;
  latestOperation: MemoryOperation;
}

/**
 * Reference implementation for memory-derived metrics.
 *
 * The module is intentionally isolated from hooks.ts so new cache-backed
 * metrics can follow the same pattern:
 * 1. classify the tool operation
 * 2. record direct per-tool metrics
 * 3. annotate the completed span for cache-based aggregation
 * 4. derive a session-level metric from cached span records
 */

export function recordMemoryToolMetrics({
  toolName,
  toolInput,
  counters,
  histograms,
  message,
  durationMs,
  agentId,
}: RecordMemoryToolMetricsParams): void {
  if (toolName === "read") {
    if (isLongTermMemoryAccess(toolInput)) {
      counters.memoryReadEvents.add(1, {
        "tool.name": toolName,
        "gen_ai.agent.id": agentId,
      });

      histograms.memoryReadDuration.record(durationMs, {
        "tool.name": toolName,
        "gen_ai.agent.id": agentId,
      });
    }
    return;
  }

  if (toolName === "write") {
    if (isLongTermMemoryAccess(toolInput)) {
      counters.memoryWriteEvents.add(1, {
        "tool.name": toolName,
        "gen_ai.agent.id": agentId,
      });
      histograms.memoryWriteDuration.record(durationMs, {
        "tool.name": toolName,
        "gen_ai.agent.id": agentId,
      });
    }
    return;
  }

  if (toolName === "edit") {
    if (isLongTermMemoryAccess(toolInput)) {
      counters.memoryEditEvents.add(1, {
        "tool.name": toolName,
        "gen_ai.agent.id": agentId,
      });
      histograms.memoryEditDuration.record(durationMs, {
        "tool.name": toolName,
        "gen_ai.agent.id": agentId,
      });
    }
    return;
  }

  if (toolName !== "memory_search") {
    return;
  }

  let toolOutput = message?.details;
  if (!toolOutput && Array.isArray(message?.content) && message.content.length > 0) {
    const text = message.content[0]?.text;
    if (typeof text === "string") {
      try {
        toolOutput = JSON.parse(text);
      } catch (err) {
        console.error("Failed to parse tool output:", err);
      }
    }
  }

  const outputObj = toolOutput;
  const results = outputObj?.results;

  counters.memoryReadEvents.add(1, {
    "tool.name": toolName,
    "gen_ai.agent.id": agentId,
  });

  if (!Array.isArray(results)) {
    return;
  }

  if (results.length === 0) {
    counters.memorySearchMiss.add(1, {
      "tool.name": toolName,
      "gen_ai.agent.id": agentId,
    });
    return;
  }

  const uniquePaths = new Set(results.map((result: any) => result?.path)).size;
  const memoryFragmentation = (uniquePaths - 1) / results.length;

  histograms.memorySearchFragmentation.record(memoryFragmentation, {
    "tool.name": toolName,
    "gen_ai.agent.id": agentId,
  });
  counters.memorySearchHit.add(1, {
    "tool.name": toolName,
    "gen_ai.agent.id": agentId,
  });
}

export function annotateMemoryToolSpan(
  span: Span,
  toolName: string,
  toolInput: unknown
): MemoryOperation | undefined {
  const operation = getMemoryOperation(toolName, toolInput);
  if (!operation) {
    return undefined;
  }

  span.setAttribute("openclaw.memory.is_long_term", true);
  span.setAttribute("openclaw.memory.operation", operation);
  return operation;
}

export function recordMemoryFailureRateFromCache({
  histograms,
  runtimeSessionKey,
  logger,
  latestOperation,
}: RecordMemoryFailureRateParams): void {
  const memoryRecords = getBySessionKey(runtimeSessionKey).filter((record) => {
    return record.spanKind === "tool" && record.attributes["openclaw.memory.is_long_term"] === true;
  });
  if (memoryRecords.length === 0) {
    return;
  }

  const failedOperations = memoryRecords.reduce((count, record) => {
    return count + (record.statusCode === SpanStatusCode.ERROR ? 1 : 0);
  }, 0);
  const failureRate = failedOperations / memoryRecords.length;

  histograms.memoryFailureRate.record(failureRate, {
    "openclaw.session.key": runtimeSessionKey,
    "openclaw.metric.scope": "session",
  });

  logger?.info?.(
    `[insightClaw:metric] openclaw.memory.failure_rate session=${runtimeSessionKey} total=${memoryRecords.length} ` +
    `failed=${failedOperations} rate=${failureRate.toFixed(4)} latestOperation=${latestOperation}`
  );
}

export function isLongTermMemoryAccess(toolInput: unknown): boolean {
  let path: string | undefined;

  if (typeof (toolInput as { path?: unknown })?.path === "string") {
    path = (toolInput as { path: string }).path;
  }

  if (!path && typeof toolInput === "string") {
    try {
      const parsed = JSON.parse(toolInput);
      if (typeof parsed?.path === "string") {
        path = parsed.path;
      }
    } catch {
      // Not JSON, ignore.
    }
  }

  const normalizedPath = typeof path === "string" ? path.toLowerCase() : undefined;
  return (
    typeof normalizedPath === "string" &&
    (normalizedPath.includes("memory") || normalizedPath.includes("memories")) &&
    normalizedPath.endsWith(".md")
  );
}

function getMemoryOperation(toolName: string, toolInput: unknown): MemoryOperation | undefined {
  if (toolName === "memory_search") {
    return "search";
  }

  if ((toolName === "read" || toolName === "write" || toolName === "edit") && isLongTermMemoryAccess(toolInput)) {
    return toolName;
  }

  return undefined;
}