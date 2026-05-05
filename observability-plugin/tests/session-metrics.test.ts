// This is the place to test all the metrics we compute at the end of a session

import test from "node:test";
import assert from "node:assert/strict";
import { context } from "@opentelemetry/api";
import { MockCounter, MockHistogram, MockTracer } from "./helpers.ts";
import { registerHooks } from "../src/hooks.ts";
import { recordSpan, SpanRecord, startSpanCache, stopSpanCache } from "../src/span-cache.ts";
import { MockTracer } from "./helpers.ts";

import {
  activeSessionCount,
  endSession,
  removeSession,
  startSessionWatcher,
  stopSessionWatcher,
  touchSession,
} from "../src/session-lifecycle.ts";

function createLogger() {
  return {
    info() {},
    debug() {},
  };
}


function createTelemetry() {
  const counter = () => new MockCounter();
  const histogram = () => new MockHistogram();

  return {
    tracer: new MockTracer(),
    meter: {},
    counters: {},
    histograms: {
      parallelisationScore: histogram(),
      repetitionScore: histogram(),
    },
    gauges: {},
    shutdown: async () => {},
  };
}


test("session parallelisation score", () => {
  // Ensure clean state before starting
  stopSessionWatcher();
  stopSpanCache();
  
  const tracer = new MockTracer();
  const logger =  createLogger();
  
  // Mock setInterval to prevent actual timers from running
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((() => ({ unref() {} })) as unknown) as typeof setInterval;

  startSessionWatcher(tracer as any,logger, 10_000);
  const telemetry = createTelemetry();
  startSpanCache({ enabled: true, logger: logger, verboseLogs: true});

  const notMainSessionId = touchSession("non-main-session-1", context.active(), "workflow-a", undefined, "webchat");

  const sessionId = touchSession("agent-session-1", context.active(), "workflow-a", undefined, "webchat");

  const sessionKey = "session-1";
  const traceId = "trace-id-123";
  const spanKind = "internal";
  
  // Use fixed timestamps to simulate time passing
  const baseTime = Date.now();

  recordSpan({
    traceId,
    spanId:"span-id-000",
    spanName: "openclaw.agent.turn",
    spanKind,
    sessionKey,
    sessionId:notMainSessionId,
    attributes: {"attr1": "value1", "attr2": "value2","openclaw.request.duration_ms":1000},
    statusCode: 0,
    recordedAt: baseTime-1000, // 1 second before the main session
  });

  // first 2 turn in parallel, then one sequential. (total duration 2 sec)
  // finally, a toll call while running the last turn (total duration 2 sec)
  // Final score: // parallelisation score = turn time / total time = 3/2
  recordSpan({
    traceId,
    spanId:"span-id-000",
    spanName: "openclaw.agent.turn",
    spanKind,
    sessionKey,
    sessionId,
    attributes: {"attr1": "value1", "attr2": "value2","openclaw.request.duration_ms":1000},
    statusCode: 0,
    recordedAt: baseTime,
  });

  recordSpan({
    traceId,
    spanId:"span-id-001",
    spanName: "openclaw.agent.turn",
    spanKind,
    sessionKey,
    sessionId,
    attributes: {"attr1": "value1", "attr2": "value2","openclaw.request.duration_ms":1000},
    statusCode: 0,
    recordedAt: baseTime,
  });
  
  recordSpan({
    traceId,
    spanId:"span-id-002",
    spanName: "openclaw.agent.turn",
    spanKind,
    sessionKey,
    sessionId,
    attributes: {"attr1": "value1", "attr2": "value2","openclaw.request.duration_ms":1000},
    statusCode: 0,
    recordedAt: baseTime + 1000, // 1 second later
  });

  recordSpan({
    traceId,
    spanId:"span-id-003",
    spanName: "openclaw.tool.call",
    spanKind,
    sessionKey,
    sessionId,
    attributes: {"attr1": "value1", "attr2": "value2","openclaw.request.duration_ms":1000},
    statusCode: 0,
    recordedAt: baseTime + 1000, // 1 second later
  });

  endSession("agent-session-1",telemetry.histograms);
  endSession("non-main-session-1",telemetry.histograms);

  assert.equal(telemetry.histograms.parallelisationScore.calls[0]?.value, 3/2);
  
  stopSessionWatcher();
  stopSpanCache();
  
  // Restore original setInterval
  globalThis.setInterval = originalSetInterval;
});



test("session loop score", () => {
  // Ensure clean state before starting
  stopSessionWatcher();
  stopSpanCache();
  
  const tracer = new MockTracer();
  const logger =  createLogger();
  
  // Mock setInterval to prevent actual timers from running
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((() => ({ unref() {} })) as unknown) as typeof setInterval;

  startSessionWatcher(tracer as any,logger, 10_000);

  const telemetry = createTelemetry();
  startSpanCache({ enabled: true, logger: logger, verboseLogs: true});

  const sessionId = touchSession("agent-session-1", context.active(), "workflow-a", undefined, "webchat");
  const sessionKey = "session-1";
  const traceId = "trace-id-123";
  const spanKind = "internal";
  
  // Use fixed timestamps to simulate time passing
  const baseTime = Date.now();
  recordSpan({
    traceId,
    spanId:"span-id-000",
    spanName: "openclaw.llm.call",
    spanKind,
    sessionKey,
    sessionId,
    attributes: {"gen_ai.agent.id": "agent00", "openclaw.entity.input": "The payment service is experiencing a critical incident with p99 latency at 4200ms and an error rate of 0.12. The checkout flow is impacted. This suggests database pressure. Investigate for lock contention, slow queries, connection pool saturation, or other database-level issues."},
    statusCode: 0,
    recordedAt: baseTime,
  });


  recordSpan({
    traceId,
    spanId:"span-id-000",
    spanName: "openclaw.llm.call",
    spanKind,
    sessionKey,
    sessionId,
    attributes: {"gen_ai.agent.id": "agent01", "openclaw.entity.input": "The payment service is experiencing a critical incident with p99 latency at 4200ms and an error rate of 0.12. The checkout flow is impacted. This suggests database pressure. Investigate for lock contention, slow queries, connection pool saturation, or other database-level issues."},
    statusCode: 0,
    recordedAt: baseTime,
  });

  recordSpan({
    traceId,
    spanId:"span-id-001",
    spanName: "openclaw.llm.call",
    spanKind,
    sessionKey,
    sessionId,
    attributes: {"gen_ai.agent.id": "agent01", "openclaw.entity.input": "The payment service is undergoing a major incident with p99 latency reaching 4200ms and an error rate of 0.12. The checkout process is affected. This indicates possible database stress. Check for lock contention, slow-running queries, connection pool exhaustion, or other database-related problems."},
    statusCode: 0,
    recordedAt: baseTime,
  });
  
  recordSpan({
    traceId,
    spanId:"span-id-001",
    spanName: "openclaw.llm.call",
    spanKind,
    sessionKey,
    sessionId,
    attributes: {"gen_ai.agent.id": "agent01", "openclaw.entity.input": "Paris is a city in France."},
    statusCode: 0,
    recordedAt: baseTime,
  });

  recordSpan({
    traceId,
    spanId:"span-id-002",
    spanName: "openclaw.llm.call",
    spanKind,
    sessionKey,
    sessionId,
    attributes: {"gen_ai.agent.id": "agent02", "openclaw.entity.input": "value2"},
    statusCode: 0,
    recordedAt: baseTime + 1000, // 1 second later
  });

  recordSpan({
    traceId,
    spanId:"span-id-003",
    spanName: "openclaw.llm.call",
    spanKind,
    sessionKey,
    sessionId,
    attributes: {"gen_ai.agent.id": "agent03", "openclaw.entity.input": "value2"},
    statusCode: 0,
    recordedAt: baseTime + 1000, // 1 second later
  });

  recordSpan({
    traceId,
    spanId:"span-id-003-missing-attribute",
    spanName: "openclaw.llm.call",
    spanKind,
    sessionKey,
    sessionId,
    attributes: {"gen_ai.agent.id": "agent03"},
    statusCode: 0,
    recordedAt: baseTime + 1000, // 1 second later
  });

  recordSpan({
    traceId,
    spanId:"span-id-003-wrong-type",
    spanName: "openclaw.llm.turn",
    spanKind,
    sessionKey,
    sessionId,
    attributes: {"gen_ai.agent.id": "agent03", "openclaw.entity.input": "value2"},
    statusCode: 0,
    recordedAt: baseTime + 1000, // 1 second later
  });

  endSession("agent-session-1",telemetry.histograms);
  assert.ok(Math.abs(telemetry.histograms.repetitionScore.calls[0]?.value - 0.4) < 0.05);
  
  stopSessionWatcher();
  stopSpanCache();
  
  // Restore original setInterval
  globalThis.setInterval = originalSetInterval;
});