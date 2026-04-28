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
    counters: {
      llmRequests: counter(),
      llmErrors: counter(),
      tokensTotal: counter(),
      tokensPrompt: counter(),
      tokensCompletion: counter(),
      toolCalls: counter(),
      toolErrors: counter(),
      sessionResets: counter(),
      messagesReceived: counter(),
      messagesSent: counter(),
      memorySearchMiss: counter(),
      memorySearchHit: counter(),
      memoryWriteEvents: counter(),
      memoryReadEvents: counter(),
      memoryEditEvents: counter(),
    },
    histograms: {
      llmDuration: histogram(),
      toolDuration: histogram(),
      agentTurnDuration: histogram(),
      memoryFailureRate: histogram(),
      memorySearchFragmentation: histogram(),
      memoryReadDuration: histogram(),
      memoryWriteDuration: histogram(),
      memoryEditDuration: histogram(),
      contextSystemSize: histogram(),
      contextHistoryMemorySize: histogram(),
      contextHistoryToolSize: histogram(),
      contextHistoryUserSize: histogram(),
      contextHistoryOtherSize: histogram(),
      contextPromptSize: histogram(),
      parallelisationScore: histogram(),
    },
    gauges: {
      activeSessions: counter(),
    },
    shutdown: async () => {},
  };
}


test("session parallelisation score", () => {
  console.log("Start Testing session parallelisation score...");

  // Ensure clean state before starting
  stopSessionWatcher();
  stopSpanCache();
  
  const tracer = new MockTracer();
  const logger =  createLogger();
  
  // Mock setInterval to prevent actual timers from running
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((() => ({ unref() {} })) as unknown) as typeof setInterval;

  startSessionWatcher(tracer as any,logger, 10_000);

  console.log("Testing session parallelisation score...");
  const telemetry = createTelemetry();
  startSpanCache({ enabled: true, logger: logger, verboseLogs: true});
  console.log("Cache started");

  const sessionId = touchSession("session-1", context.active(), "workflow-a");

  const sessionKey = "session-1";
  const traceId = "trace-id-123";
  const spanKind = "internal";
  
  // Use fixed timestamps to simulate time passing
  const baseTime = Date.now();

  console.log("Recording spans...");
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

  endSession("session-1",telemetry.histograms);

  assert.equal(telemetry.histograms.parallelisationScore.calls[0]?.value, 3/2);
  
  stopSessionWatcher();
  stopSpanCache();
  
  // Restore original setInterval
  globalThis.setInterval = originalSetInterval;
});