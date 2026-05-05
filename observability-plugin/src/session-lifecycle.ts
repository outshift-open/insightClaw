/**
 * Session Lifecycle Management — automatic session start/end detection.
 *
 * A session here represents the user workflow lifecycle tracked by this plugin.
 * OpenClaw session identifiers are treated as runtime-session correlation keys
 * and are attached as metadata on our session spans.
 */

import { randomUUID } from "node:crypto";
import { trace, SpanKind, SpanStatusCode, type Span } from "@opentelemetry/api";
import type { Context, Tracer } from "@opentelemetry/api";
import {
  ATTR_OBSERVE_SPAN_KIND,
  ObserveSpanKind,
} from "./observe-attributes.js";
import { flushBySessionKey, getSessionEndTime, getSessionStartTime, getSpansByType, startSpanCache, stopSpanCache } from "./span-cache.js";
import { computeStringSimilarity } from "./context-analysis.js";

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
  /** Long-lived span that acts as the trace root for the entire session. */
  sessionSpan?: Span;
  /** OTel context with sessionSpan active — used as parent for all request spans. */
  sessionContext?: Context;
  workflowName?: string;
  ended: boolean;
  channel?: string;
}

// ── State ──────────────────────────────────────────────────────────

const sessions = new Map<string, SessionActivity>();
let watcherTimer: ReturnType<typeof setInterval> | null = null;
let tracerRef: Tracer | null = null;
let loggerRef: any = null;
let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;

// ── Other configuration ──────────────────────────────────────────────────────────
let embeddingsProcessing = false;

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
  histograms: any,
  logger: any,
  idleTimeout?: number,
  options?: { enableSpanCache?: boolean; spanCacheVerboseLogs?: boolean, embeddingsProcessing?: boolean }
): void {
  tracerRef = tracer;
  loggerRef = logger;
  if (idleTimeout && idleTimeout >= 10_000) {
    idleTimeoutMs = idleTimeout;
  }
  if (options?.embeddingsProcessing === true) {
    embeddingsProcessing = true;
  }

  if (watcherTimer) {
    logger.debug?.("[otel:session] Session watcher already running, skipping");
    return;
  }

  watcherTimer = setInterval(() => {
    checkIdleSessions(histograms);
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
  inheritedSessionId?: string,
  channel?: string
): string {
  const now = Date.now();
  const existing = sessions.get(runtimeSessionKey);
  if (existing) {
    existing.lastActivityAt = now;
    existing.rootContext = rootContext;
    if (workflowName) existing.workflowName = workflowName;

    // If an inherited session ID is provided (e.g. via sessions_send from another
    // agent) and this session has a different ID, merge into the inherited session
    // so all spans share the same session.id across agents.
    if (inheritedSessionId && inheritedSessionId !== existing.sessionId) {
      const inheritedSession = findSessionById(inheritedSessionId);
      if (inheritedSession && !inheritedSession.ended) {
        loggerRef?.info?.(
          `[otel:session] Merging session=${existing.sessionId} into session=${inheritedSession.sessionId} ` +
          `for runtimeSession=${runtimeSessionKey}`
        );
        for (const key of existing.runtimeSessionKeys) {
          sessions.set(key, inheritedSession);
          inheritedSession.runtimeSessionKeys.add(key);
        }
        inheritedSession.lastActivityAt = now;
        existing.runtimeSessionKeys.clear();
        existing.ended = true;
        // Close the orphaned session.start span without emitting session.end
        if (existing.sessionSpan) {
          existing.sessionSpan.setStatus({ code: SpanStatusCode.OK });
          existing.sessionSpan.end();
          existing.sessionSpan = undefined;
        }
        return inheritedSession.sessionId;
      }
    }

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
    const sessionId = inheritedSessionId || randomUUID();

    // Create the long-lived session.start span that will act as root for all
    // spans in this session. It stays open until emitSessionEnd is called.
    let sessionSpan: Span | undefined;
    let sessionContext: Context | undefined;
    if (tracerRef) {
      try {
        sessionSpan = tracerRef.startSpan(
          "session.start",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              [ATTR_OBSERVE_SPAN_KIND]: ObserveSpanKind.WORKFLOW,
              "session.id": sessionId,
              "session.started_at": new Date(startedAt).toISOString(),
              "openclaw.session.key": runtimeSessionKey,
              ...(workflowName ? { "ioa_observe.workflow.name": workflowName } : {}),
            },
          },
          rootContext
        );
        sessionContext = trace.setSpan(rootContext, sessionSpan);
        loggerRef?.debug?.(`[otel:session] session.start span opened for session=${sessionId}`);
      } catch {
        // If span creation fails the session still works without a root span
      }
    }

    const session: SessionActivity = {
      sessionId,
      primaryRuntimeSessionKey: runtimeSessionKey,
      runtimeSessionKeys: new Set([runtimeSessionKey]),
      lastActivityAt: startedAt,
      rootContext,
      sessionSpan,
      sessionContext,
      workflowName,
      ended: false,
      channel: channel,
    };

    sessions.set(runtimeSessionKey, session);
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
 * Return the OTel context with the long-lived session.start span active.
 * Use this as the parent context when creating root request spans so that
 * every span in the session descends from session.start.
 */
export function getSessionContext(runtimeSessionKey: string): Context | undefined {
  return sessions.get(runtimeSessionKey)?.sessionContext;
}

/**
 * Return the SpanContext of the long-lived session.start span for the given
 * runtime session key. Use this to build span links that point to the session root.
 */
export function getSessionSpanContext(runtimeSessionKey: string): import("@opentelemetry/api").SpanContext | undefined {
  return sessions.get(runtimeSessionKey)?.sessionSpan?.spanContext();
}

/**
 * Explicitly end a session associated with a runtime session key.
 * Prevents duplicate session.end emissions.
 */
export function endSession(runtimeSessionKey: string, histograms?: any): void {
  const session = sessions.get(runtimeSessionKey);
  if (!session) {
    return;
  }
  //computing end of session scores 
  if (histograms) {
    recordEndOfSessionMetrics(runtimeSessionKey, histograms, embeddingsProcessing);
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
export function removeSession(runtimeSessionKey: string, histograms?: any): void {
  const session = sessions.get(runtimeSessionKey);
  if (!session) {
    return;
  }

  if (histograms) {
    //computing end of session scores
    recordEndOfSessionMetrics(runtimeSessionKey, histograms, embeddingsProcessing);
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


/**
 * Compute all the derived metrics on the session that just terminated 
 */
export function recordEndOfSessionMetrics(runtimeSessionKey: string, histograms: any, embeddingsProcessing?: boolean): void {
  recordParallelisationScore(runtimeSessionKey, histograms);
  recordRepetitionScore(runtimeSessionKey, histograms, embeddingsProcessing);
}


/**
 * Computes the repetition score: given all the LLM calls (openclaw.llm.call) in a session (including sub-agents and other top-level agents),
 * we compute the Jaccard similarity of the prompts between each pair of calls for the same agent (or embedding based similarity if embeddingsProcessing)
 * The final score reflects the presence of repetition in the prompts for the same agent
 */
function recordRepetitionScore(runtimeSessionKey: string, histograms: any, embeddingsProcessing?: boolean): void {
  const sessionId = getSessionId(runtimeSessionKey);
  if (!sessionId) {
    loggerRef?.warn?.(`[otel:session] Cannot record repetition score, session not found for runtimeSessionKey=${runtimeSessionKey}`);
    return;
  }

  const session = sessions.get(runtimeSessionKey);
  if (!session) {
    loggerRef?.warn?.(`[otel:session] Cannot record repetition score, session not found for sessionId=${sessionId}`);
    return;
  }

  if (!session.channel || session.channel === "heartbeat") {
    // we do not compute the score for heartbeat sessions
    loggerRef?.debug?.(`[otel:session] Skipping repetition score for heartbeat session: session=${sessionId}`);
    return;
  }

  // Getting all spans of type llm call
  const calls = getSpansByType("openclaw.llm.call", undefined, undefined, sessionId);

  const callsByAgent = new Map<string, Array<{ prompt: string }>>();    
  
  let rootAgent = "unknown"; // we filter outs calls performed direclty by the root agent, as they are not repetitions but rather the main driver of the session
  let rootStartTime = -1;

  for (const call of calls) {
    const agentId = call.attributes["gen_ai.agent.id"] as string | undefined;
    const prompt = call.attributes["openclaw.entity.input"] as string | undefined;
    const startTime = call.startAt //|| call.recordedAt;
    if (!agentId || !prompt) continue;
      
    if (!callsByAgent.has(agentId)) {
      callsByAgent.set(agentId, []);
    }
    if (startTime && (rootStartTime === -1 || startTime < rootStartTime)) {
      rootStartTime = startTime;
      rootAgent = agentId;
    }

    loggerRef?.debug?.(`[otel:session] Recording call for agent ${agentId} with prompt: ${prompt} startTime: ${startTime} rootAgent: ${rootAgent} rootStartTime: ${rootStartTime}`);
    callsByAgent.get(agentId)!.push({ prompt });
  }
  loggerRef?.debug?.(`[otel:session] Computing repetition score for session ${sessionId}-${runtimeSessionKey} (rootAgent=${rootAgent})`);

  // Wrap async computation to avoid blocking
  (async () => {
    const scores = new Array<number>();

    for (const [agentId, agentCalls] of callsByAgent) {
      if (agentId === rootAgent) {
        loggerRef?.debug?.(`[otel:session] Skipping repetition score for root agent ${agentId}`);
        continue;
      }
      if (agentCalls.length < 2) continue;
      
      //for each pair of call, compute the getJaccardSimilarity of the prompt

      const agentScores = new Array<number>();
      for (let i = 0; i < agentCalls.length; i++) {
        for (let j = i + 1; j < agentCalls.length; j++) {
          let similarity = 0;
          if (embeddingsProcessing) {
            similarity = await computeStringSimilarity(agentCalls[i].prompt, agentCalls[j].prompt, "embedding");
          } else {
            similarity = computeStringSimilarity(agentCalls[i].prompt, agentCalls[j].prompt, "jaccard");
          }
          loggerRef?.info?.(`[otel:session] ${embeddingsProcessing ? "embeddings" : "jaccard"} similarity: session=${sessionId}, agent=${agentId}, similarity=${similarity}`);
          loggerRef?.info?.(`[otel:session] ${embeddingsProcessing ? "embeddings" : "jaccard"} A=${agentCalls[i].prompt} B=${agentCalls[j].prompt}`);
          agentScores.push(similarity);
        }
      }
      scores.push(Math.max(...agentScores));
    }

    let finalScore = 0;
    if (scores.length > 0) {
      finalScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    }
    loggerRef?.info?.(`[otel:session] Final repetition score for session ${sessionId}-${runtimeSessionKey}: ${finalScore}`);

    histograms.repetitionScore.record(finalScore, { "openclaw.session.key": runtimeSessionKey });
  })().catch((err) => {
    loggerRef?.warn?.(`[otel:session] Error computing repetition score: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** 
 * The score is the ratio between the sum of durations of spans of type agent turn, and the total session duration.
 * All the spans recorded during the session lifecycle are considered, no matter their session IDs (thus including sub-agents and other top-level agent)
 * 
 * The higher the score, the more parallelization there was in the session (i.e., multiple agents working at the same time, or an agent working while waiting for a tool response).
 * Low score means low parallelisation or the ageint waiting for external actions.
 * 
*/
export function recordParallelisationScore(runtimeSessionKey: string, histograms: any): void {
  const sessionId = getSessionId(runtimeSessionKey);
  if (!sessionId) {
    loggerRef?.warn?.(`[otel:session] Cannot record parallelisation score, session not found for runtimeSessionKey=${runtimeSessionKey}`);
    return;
  }

  const session = sessions.get(runtimeSessionKey);
  if (!session) {
    loggerRef?.warn?.(`[otel:session] Cannot record parallelisation score, session not found for sessionId=${sessionId}`);
    return;
  }

  if (!session.channel || session.channel === "heartbeat") {
    // we do not compute the score for heartbeat sessions
    loggerRef?.debug?.(`[otel:session] Skipping parallelisation score for heartbeat session: session=${sessionId}`);
    return;
  }

  const startTime = getSessionStartTime(sessionId);
  if (!startTime) {
    loggerRef?.warn?.(`[otel:session] Cannot record parallelisation score, session not found: session=${sessionId}`);
    return;
  }

  const endTime = getSessionEndTime(sessionId);
  if (!endTime) {
    loggerRef?.warn?.(`[otel:session] Cannot record parallelisation score, session not ended: session=${sessionId}`);
    return;
  }
  const sessionDurationTillNow = endTime - startTime;
  const spans = getSpansByType("openclaw.agent.turn", undefined, undefined, sessionId);

  const durationKeys = [
    "openclaw.request.duration_ms",
    "openclaw.agent.duration_ms",
    "openclaw.tool.duration_ms"
  ];
  
  let spansDuration = 0
  for (const r of spans) {
    let found = false;
    for (const key of durationKeys) {
      const duration = r.attributes[key];
      if (typeof duration === "number") {
        spansDuration += duration;
        found = true;
        break;
      }
    }
    if (!found) {
      loggerRef?.warn?.(`[otel:session] Span without duration attribute: session=${sessionId}, span=${r.spanId}, attributes=${JSON.stringify(r.attributes)}`);
    }
  }
  const score = spansDuration / sessionDurationTillNow; 
  loggerRef?.info?.(`[otel:session] Parallelisation score for session ${sessionId}-${runtimeSessionKey}: ${score} (spansDuration=${spansDuration}ms, sessionDuration=${sessionDurationTillNow}ms)`);
  histograms.parallelisationScore.record(score, { "openclaw.session.key": runtimeSessionKey });
}

// ── Internal ───────────────────────────────────────────────────────

function checkIdleSessions(histograms?: any): void {
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
      if(histograms) {
        //computing end of session scores
        recordEndOfSessionMetrics(session.primaryRuntimeSessionKey,histograms, embeddingsProcessing);
      }
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



function emitSessionEnd(session: SessionActivity): void {
  if (session.ended || !tracerRef) return;
  session.ended = true;

  try {
    // Emit session.end as a child span nested inside the long-lived session.start span.
    const parentContext = session.sessionContext ?? session.rootContext;
    const endSpan = tracerRef.startSpan(
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
      parentContext
    );
    endSpan.setStatus({ code: SpanStatusCode.OK });
    endSpan.end();

    // Close the long-lived session.start root span.
    if (session.sessionSpan) {
      session.sessionSpan.setAttribute("session.ended_at", new Date(session.lastActivityAt).toISOString());
      session.sessionSpan.setStatus({ code: SpanStatusCode.OK });
      session.sessionSpan.end();
    }

    loggerRef?.debug?.(`[otel:session] session.start span closed for session=${session.sessionId}`);
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
