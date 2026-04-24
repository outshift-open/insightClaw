/**
 * Session Lifecycle Management — automatic session start/end detection.
 *
 * A session here represents the user workflow lifecycle tracked by this plugin.
 * OpenClaw session identifiers are treated as runtime-session correlation keys
 * and are attached as metadata on our session spans.
 */

import { randomUUID } from "node:crypto";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Context, Tracer } from "@opentelemetry/api";
import {
  ATTR_OBSERVE_SPAN_KIND,
  ObserveSpanKind,
} from "./observe-attributes.js";
import { flushBySessionKey, startSpanCache, stopSpanCache } from "./span-cache.js";

// ── Configuration ──────────────────────────────────────────────────

/** Default idle timeout before emitting session.end (ms) */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** How often the watcher checks for idle sessions (ms) */
const WATCHER_INTERVAL_MS = 30_000; // 30 seconds

// ── Types ──────────────────────────────────────────────────────────

interface SessionActivity {
  sessionId: string;
  primaryRuntimeSessionKey: string;
  runtimeSessionKeys: Set<string>;
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

function getUniqueSessions(): SessionActivity[] {
  return [...new Set(sessions.values())];
}

function findSessionById(sessionId: string): SessionActivity | undefined {
  return getUniqueSessions().find((session) => session.sessionId === sessionId);
}

function detachRuntimeSessionKey(runtimeSessionKey: string, session: SessionActivity): void {
  sessions.delete(runtimeSessionKey);
  session.runtimeSessionKeys.delete(runtimeSessionKey);

  if (session.primaryRuntimeSessionKey === runtimeSessionKey) {
    session.primaryRuntimeSessionKey = session.runtimeSessionKeys.values().next().value ?? runtimeSessionKey;
  }
}

function deleteSessionAliases(session: SessionActivity): void {
  for (const runtimeSessionKey of session.runtimeSessionKeys) {
    sessions.delete(runtimeSessionKey);
  }
  session.runtimeSessionKeys.clear();
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Start the session lifecycle watcher.
 */
export function startSessionWatcher(
  tracer: Tracer,
  logger: any,
  idleTimeout?: number,
  options?: { enableSpanCache?: boolean; spanCacheVerboseLogs?: boolean }
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

  // Start the span cache background sweep only when explicitly enabled.
  startSpanCache({
    logger,
    enabled: options?.enableSpanCache === true,
    verboseLogs: options?.spanCacheVerboseLogs === true,
  });

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
  stopSpanCache();
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
  workflowName?: string,
  inheritedSessionId?: string
): string {
  const now = Date.now();
  const existing = sessions.get(runtimeSessionKey);
  if (existing) {
    existing.lastActivityAt = now;
    existing.rootContext = rootContext;
    if (workflowName) existing.workflowName = workflowName;
    return existing.sessionId;
  } else {
    const adopted = inheritedSessionId ? findSessionById(inheritedSessionId) : undefined;
    if (adopted) {
      adopted.lastActivityAt = now;
      adopted.rootContext = rootContext;
      if (workflowName) adopted.workflowName = workflowName;
      adopted.runtimeSessionKeys.add(runtimeSessionKey);
      sessions.set(runtimeSessionKey, adopted);
      loggerRef?.info?.(
        `[otel:session] Aliased runtime session: session=${adopted.sessionId}, runtimeSession=${runtimeSessionKey}, primaryRuntimeSession=${adopted.primaryRuntimeSessionKey}, activeSessions=${getUniqueSessions().length}`
      );
      return adopted.sessionId;
    }

    const startedAt = now;
    const session: SessionActivity = {
      sessionId: inheritedSessionId || randomUUID(),
      primaryRuntimeSessionKey: runtimeSessionKey,
      runtimeSessionKeys: new Set([runtimeSessionKey]),
      lastActivityAt: startedAt,
      rootContext,
      workflowName,
      ended: false,
    };
    sessions.set(runtimeSessionKey, session);
    emitSessionStart(session);
    loggerRef?.info?.(
      `[otel:session] New session tracked: session=${session.sessionId}, runtimeSession=${runtimeSessionKey}, activeSessions=${getUniqueSessions().length}`
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
  if (!session) {
    return;
  }

  detachRuntimeSessionKey(runtimeSessionKey, session);
  flushBySessionKey(runtimeSessionKey);

  if (session.runtimeSessionKeys.size > 0) {
    loggerRef?.debug?.(
      `[otel:session] Detached runtime session alias: session=${session.sessionId}, runtimeSession=${runtimeSessionKey}, remainingAliases=${session.runtimeSessionKeys.size}`
    );
    return;
  }

  if (!session.ended) {
    loggerRef?.info?.(
      `[otel:session] Explicit session end: session=${session.sessionId}, runtimeSession=${runtimeSessionKey}`
    );
    emitSessionEnd(session);
  }
}

/**
 * Remove a session without emitting session.end (e.g., normal cleanup).
 */
export function removeSession(runtimeSessionKey: string): void {
  const session = sessions.get(runtimeSessionKey);
  if (!session) {
    return;
  }

  detachRuntimeSessionKey(runtimeSessionKey, session);
  if (session.runtimeSessionKeys.size === 0) {
    session.ended = true;
  }
}

/**
 * Get count of active (non-ended) sessions.
 */
export function activeSessionCount(): number {
  let count = 0;
  for (const s of getUniqueSessions()) {
    if (!s.ended) count++;
  }
  return count;
}

// ── Internal ───────────────────────────────────────────────────────

function checkIdleSessions(): void {
  const now = Date.now();
  let idleCount = 0;
  for (const session of getUniqueSessions()) {
    if (session.ended) continue;
    const idleMs = now - session.lastActivityAt;
    if (idleMs > idleTimeoutMs) {
      loggerRef?.info?.(
        `[otel:session] Session idle timeout: session=${session.sessionId}, runtimeSession=${session.primaryRuntimeSessionKey}, ` +
        `idleFor=${Math.round(idleMs / 1000)}s (threshold=${Math.round(idleTimeoutMs / 1000)}s)`
      );
      emitSessionEnd(session);
      for (const runtimeSessionKey of session.runtimeSessionKeys) {
        flushBySessionKey(runtimeSessionKey);
      }
      deleteSessionAliases(session);
      idleCount++;
    }
  }
  if (getUniqueSessions().length > 0 || idleCount > 0) {
    loggerRef?.debug?.(
      `[otel:session] Idle check: active=${getUniqueSessions().length}, expired=${idleCount}`
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
          "openclaw.session.key": session.primaryRuntimeSessionKey,
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
          "openclaw.session.key": session.primaryRuntimeSessionKey,
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
  const remaining = getUniqueSessions().filter(s => !s.ended);
  if (remaining.length > 0) {
    loggerRef?.info?.(
      `[otel:session] Process exit — emitting session.end for ${remaining.length} active session(s): ` +
      `[${remaining.map(s => s.sessionId).join(", ")}]`
    );
  }
  for (const session of remaining) {
    if (!session.ended) {
      emitSessionEnd(session);
    }
  }
  sessions.clear();
}
