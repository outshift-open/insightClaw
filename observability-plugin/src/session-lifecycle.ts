/**
 * Session Lifecycle Management — automatic session end detection.
 *
 * Ported from agntcy/observe SDK concepts:
 *   - Background watcher monitors session activity
 *   - When a session is idle for a configurable duration, emits session.end span
 *   - At process exit, remaining active sessions receive session.end spans
 *   - Prevents duplicate session.end spans
 *
 * This complements the stale cleanup in hooks.ts by providing proper
 * session.end telemetry rather than just silently dropping spans.
 */

import { SpanKind, SpanStatusCode, trace, context } from "@opentelemetry/api";
import type { Tracer, Span, Context } from "@opentelemetry/api";
import {
  ATTR_OBSERVE_SPAN_KIND,
  ObserveSpanKind,
} from "./observe-attributes.js";

// ── Configuration ──────────────────────────────────────────────────

/** Default idle timeout before emitting session.end (ms) */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** How often the watcher checks for idle sessions (ms) */
const WATCHER_INTERVAL_MS = 30_000; // 30 seconds

// ── Types ──────────────────────────────────────────────────────────

interface SessionActivity {
  sessionKey: string;
  lastActivityAt: number;
  rootContext: Context;
  workflowName?: string;
  ended: boolean;
}

// ── State ──────────────────────────────────────────────────────────

const sessions = new Map<string, SessionActivity>();
let watcherTimer: ReturnType<typeof setInterval> | null = null;
let tracerRef: Tracer | null = null;
let loggerRef: any = null;
let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;

// ── Public API ─────────────────────────────────────────────────────

/**
 * Start the session lifecycle watcher.
 */
export function startSessionWatcher(
  tracer: Tracer,
  logger: any,
  idleTimeout?: number
): void {
  tracerRef = tracer;
  loggerRef = logger;
  if (idleTimeout && idleTimeout >= 10_000) {
    idleTimeoutMs = idleTimeout;
  }

  if (watcherTimer) {
    logger.debug?.("[otel:session] Session watcher already running, skipping");
    return;
  }

  watcherTimer = setInterval(() => {
    checkIdleSessions();
  }, WATCHER_INTERVAL_MS);

  // Emit session.end for all remaining sessions on process exit
  process.on("beforeExit", emitAllSessionEnds);
  process.on("SIGTERM", emitAllSessionEnds);
  process.on("SIGINT", emitAllSessionEnds);

  logger.info?.(
    `[otel:session] Session lifecycle watcher started (idleTimeout=${idleTimeoutMs}ms, checkInterval=${WATCHER_INTERVAL_MS}ms)`
  );
}

/**
 * Stop the session lifecycle watcher.
 */
export function stopSessionWatcher(): void {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
    loggerRef?.debug?.("[otel:session] Session watcher stopped");
  }
  process.removeListener("beforeExit", emitAllSessionEnds);
  process.removeListener("SIGTERM", emitAllSessionEnds);
  process.removeListener("SIGINT", emitAllSessionEnds);
}

/**
 * Record session activity (called on message_received, tool_result_persist, etc.)
 */
export function touchSession(
  sessionKey: string,
  rootContext: Context,
  workflowName?: string
): void {
  const existing = sessions.get(sessionKey);
  if (existing) {
    existing.lastActivityAt = Date.now();
    if (workflowName) existing.workflowName = workflowName;
  } else {
    sessions.set(sessionKey, {
      sessionKey,
      lastActivityAt: Date.now(),
      rootContext,
      workflowName,
      ended: false,
    });
    loggerRef?.info?.(
      `[otel:session] New session tracked: session=${sessionKey}, activeSessions=${sessions.size}`
    );
  }
}

/**
 * Explicitly end a session (e.g., on command:reset).
 * Prevents duplicate session.end emissions.
 */
export function endSession(sessionKey: string): void {
  const session = sessions.get(sessionKey);
  if (session && !session.ended) {
    loggerRef?.info?.(
      `[otel:session] Explicit session end: session=${sessionKey}`
    );
    emitSessionEnd(session);
  }
  sessions.delete(sessionKey);
}

/**
 * Remove a session without emitting session.end (e.g., normal cleanup).
 */
export function removeSession(sessionKey: string): void {
  sessions.delete(sessionKey);
}

/**
 * Get count of active (non-ended) sessions.
 */
export function activeSessionCount(): number {
  let count = 0;
  for (const s of sessions.values()) {
    if (!s.ended) count++;
  }
  return count;
}

// ── Internal ───────────────────────────────────────────────────────

function checkIdleSessions(): void {
  const now = Date.now();
  let idleCount = 0;
  for (const [key, session] of sessions) {
    if (session.ended) continue;
    const idleMs = now - session.lastActivityAt;
    if (idleMs > idleTimeoutMs) {
      loggerRef?.info?.(
        `[otel:session] Session idle timeout: session=${key}, ` +
        `idleFor=${Math.round(idleMs / 1000)}s (threshold=${Math.round(idleTimeoutMs / 1000)}s)`
      );
      emitSessionEnd(session);
      sessions.delete(key);
      idleCount++;
    }
  }
  if (sessions.size > 0 || idleCount > 0) {
    loggerRef?.debug?.(
      `[otel:session] Idle check: active=${sessions.size}, expired=${idleCount}`
    );
  }
}

function emitSessionEnd(session: SessionActivity): void {
  if (session.ended || !tracerRef) return;
  session.ended = true;

  try {
    const span = tracerRef.startSpan(
      "session.end",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          [ATTR_OBSERVE_SPAN_KIND]: ObserveSpanKind.WORKFLOW,
          "session.id": session.sessionKey,
          "session.ended_at": new Date(session.lastActivityAt).toISOString(),
          ...(session.workflowName
            ? { "ioa_observe.workflow.name": session.workflowName }
            : {}),
        },
      },
      session.rootContext
    );
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    loggerRef?.debug?.(
      `[otel] Emitted session.end for session=${session.sessionKey}`
    );
  } catch {
    // Never let session telemetry errors propagate
  }
}

function emitAllSessionEnds(): void {
  const remaining = [...sessions.values()].filter(s => !s.ended);
  if (remaining.length > 0) {
    loggerRef?.info?.(
      `[otel:session] Process exit — emitting session.end for ${remaining.length} active session(s): ` +
      `[${remaining.map(s => s.sessionKey).join(", ")}]`
    );
  }
  for (const [key, session] of sessions) {
    if (!session.ended) {
      emitSessionEnd(session);
    }
  }
  sessions.clear();
}
