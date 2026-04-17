/**
 * Session Lifecycle Management — automatic session start/end detection.
 *
 * A session here represents the user workflow lifecycle tracked by this plugin.
 * OpenClaw session identifiers are treated as runtime-session correlation keys
 * and are attached as metadata on our session spans.
 */

import { randomUUID } from "node:crypto";
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
  sessionId: string;
  runtimeSessionKey: string;
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
 * Record session activity for a runtime session key.
 */
export function touchSession(
  runtimeSessionKey: string,
  rootContext: Context,
  workflowName?: string
): string {
  const existing = sessions.get(runtimeSessionKey);
  if (existing) {
    existing.lastActivityAt = Date.now();
    if (workflowName) existing.workflowName = workflowName;
    return existing.sessionId;
  } else {
    const startedAt = Date.now();
    const session: SessionActivity = {
      sessionId: randomUUID(),
      runtimeSessionKey,
      lastActivityAt: startedAt,
      rootContext,
      workflowName,
      ended: false,
    };
    sessions.set(runtimeSessionKey, session);
    emitSessionStart(session);
    loggerRef?.info?.(
      `[otel:session] New session tracked: session=${session.sessionId}, runtimeSession=${runtimeSessionKey}, activeSessions=${sessions.size}`
    );
    return session.sessionId;
  }
}

export function getSessionId(runtimeSessionKey: string): string | undefined {
  return sessions.get(runtimeSessionKey)?.sessionId;
}

/**
 * Explicitly end a session associated with a runtime session key.
 * Prevents duplicate session.end emissions.
 */
export function endSession(runtimeSessionKey: string): void {
  const session = sessions.get(runtimeSessionKey);
  if (session && !session.ended) {
    loggerRef?.info?.(
      `[otel:session] Explicit session end: session=${session.sessionId}, runtimeSession=${runtimeSessionKey}`
    );
    emitSessionEnd(session);
  }
  sessions.delete(runtimeSessionKey);
}

/**
 * Remove a session without emitting session.end (e.g., normal cleanup).
 */
export function removeSession(runtimeSessionKey: string): void {
  sessions.delete(runtimeSessionKey);
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
        `[otel:session] Session idle timeout: session=${session.sessionId}, runtimeSession=${key}, ` +
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

function emitSessionStart(session: SessionActivity): void {
  if (!tracerRef) return;

  try {
    const span = tracerRef.startSpan(
      "session.start",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          [ATTR_OBSERVE_SPAN_KIND]: ObserveSpanKind.WORKFLOW,
          "session.id": session.sessionId,
          "session.started_at": new Date(session.lastActivityAt).toISOString(),
          "openclaw.session.key": session.runtimeSessionKey,
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
      `[otel] Emitted session.start for session=${session.sessionId}`
    );
  } catch {
    // Never let session telemetry errors propagate
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
          "session.id": session.sessionId,
          "session.ended_at": new Date(session.lastActivityAt).toISOString(),
          "openclaw.session.key": session.runtimeSessionKey,
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
      `[otel] Emitted session.end for session=${session.sessionId}`
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
      `[${remaining.map(s => s.sessionId).join(", ")}]`
    );
  }
  for (const [key, session] of sessions) {
    if (!session.ended) {
      emitSessionEnd(session);
    }
  }
  sessions.clear();
}
