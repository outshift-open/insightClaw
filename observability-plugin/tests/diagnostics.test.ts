import test from "node:test";
import assert from "node:assert/strict";

import {
  getPendingUsage,
  registerActiveAgentSpan,
  registerDiagnosticsListener,
  setOnDiagnosticEventForTest,
  unregisterActiveAgentSpan,
} from "../src/diagnostics.ts";
import { MockCounter, MockHistogram, MockTracer } from "./helpers.ts";

function createTelemetry() {
  const counters = new Map<string, MockCounter>();
  const histograms = new Map<string, MockHistogram>();

  const meter = {
    createCounter(name: string) {
      const counter = new MockCounter();
      counters.set(name, counter);
      return counter;
    },
    createHistogram(name: string) {
      const histogram = new MockHistogram();
      histograms.set(name, histogram);
      return histogram;
    },
  };

  return {
    tracer: new MockTracer(),
    meter,
    counters: {
      llmRequests: new MockCounter(),
      llmErrors: new MockCounter(),
      tokensTotal: new MockCounter(),
      tokensPrompt: new MockCounter(),
      tokensCompletion: new MockCounter(),
      toolCalls: new MockCounter(),
      toolErrors: new MockCounter(),
      sessionResets: new MockCounter(),
      messagesReceived: new MockCounter(),
      messagesSent: new MockCounter(),
      securityEvents: new MockCounter(),
      sensitiveFileAccess: new MockCounter(),
      promptInjection: new MockCounter(),
      dangerousCommand: new MockCounter(),
    },
    histograms: {
      llmDuration: new MockHistogram(),
      toolDuration: new MockHistogram(),
      agentTurnDuration: new MockHistogram(),
    },
    gauges: {
      activeSessions: new MockCounter(),
    },
    shutdown: async () => {},
    metricCounters: counters,
    metricHistograms: histograms,
  };
}

function createDiagnosticBus() {
  let listener: ((evt: any) => void) | undefined;

  return {
    subscribe(next: (evt: any) => void) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    emit(evt: any) {
      listener?.(evt);
    },
  };
}

const logger = {
  debug() {},
  info() {},
  warn() {},
};

test("registerDiagnosticsListener correlates model usage by sessionId", async () => {
  const bus = createDiagnosticBus();
  const telemetry = createTelemetry();
  setOnDiagnosticEventForTest(bus.subscribe);

  const unsubscribe = await registerDiagnosticsListener(telemetry as any, logger);
  const agentSpan = telemetry.tracer.startSpan("openclaw.agent.turn") as any;

  registerActiveAgentSpan(["session-123"], agentSpan);

  bus.emit({
    type: "model.usage",
    sessionId: "session-123",
    provider: "anthropic",
    model: "claude-sonnet-4",
    usage: { input: 12, output: 8, total: 20 },
    context: { limit: 200_000, used: 2_048 },
    costUsd: 0.42,
    durationMs: 180,
  });

  assert.equal(agentSpan.attributes.get("gen_ai.usage.input_tokens"), 12);
  assert.equal(agentSpan.attributes.get("gen_ai.usage.output_tokens"), 8);
  assert.equal(agentSpan.attributes.get("gen_ai.usage.total_tokens"), 20);
  assert.equal(agentSpan.attributes.get("openclaw.llm.cost_usd"), 0.42);
  assert.equal(agentSpan.attributes.get("openclaw.context.limit"), 200_000);
  assert.equal(agentSpan.attributes.get("openclaw.context.used"), 2_048);
  assert.equal(agentSpan.attributes.get("gen_ai.system"), "anthropic");
  assert.equal(agentSpan.attributes.get("gen_ai.response.model"), "claude-sonnet-4");
  assert.equal(telemetry.counters.tokensPrompt.calls[0]?.value, 12);
  assert.equal(telemetry.counters.tokensCompletion.calls[0]?.value, 8);
  assert.equal(telemetry.counters.tokensTotal.calls[0]?.value, 20);
  assert.equal(telemetry.counters.llmRequests.calls[0]?.value, 1);
  assert.equal(telemetry.histograms.llmDuration.calls[0]?.value, 180);
  assert.equal(telemetry.metricCounters.get("openclaw.cost.usd")?.calls[0]?.value, 0.42);
  assert.ok(telemetry.tracer.spans.some((entry) => entry.name === "openclaw.model.usage"));
  assert.equal(getPendingUsage("session-123"), undefined);

  unregisterActiveAgentSpan(["session-123"]);
  unsubscribe();
  setOnDiagnosticEventForTest(null);
});

test("registerDiagnosticsListener records the broader diagnostic event stream", async () => {
  const bus = createDiagnosticBus();
  const telemetry = createTelemetry();
  setOnDiagnosticEventForTest(bus.subscribe);

  const unsubscribe = await registerDiagnosticsListener(telemetry as any, logger);

  bus.emit({
    type: "model.usage",
    sessionKey: "agent:planner:main",
    sessionId: "session-456",
    provider: "anthropic",
    model: "claude-sonnet-4",
    usage: { input: 5, output: 3, total: 8 },
  });

  const pendingUsage = getPendingUsage("session-456");
  assert.equal(pendingUsage?.usage.total, 8);
  assert.equal(getPendingUsage("agent:planner:main"), undefined);

  bus.emit({ type: "webhook.received", channel: "telegram", updateType: "message" });
  bus.emit({ type: "webhook.processed", channel: "telegram", updateType: "message", durationMs: 55 });
  bus.emit({ type: "webhook.error", channel: "telegram", updateType: "message", error: "boom" });
  bus.emit({ type: "message.queued", channel: "telegram", source: "webhook", queueDepth: 2 });
  bus.emit({
    type: "message.processed",
    channel: "telegram",
    outcome: "error",
    durationMs: 75,
    sessionId: "session-456",
    reason: "handler failed",
    error: "handler failed",
  });
  bus.emit({ type: "queue.lane.enqueue", lane: "main", queueSize: 2 });
  bus.emit({ type: "queue.lane.dequeue", lane: "main", queueSize: 1, waitMs: 14 });
  bus.emit({ type: "session.state", state: "waiting", reason: "retry" });
  bus.emit({ type: "session.stuck", sessionId: "session-456", state: "processing", ageMs: 120_000, queueDepth: 4 });
  bus.emit({ type: "run.attempt", attempt: 2, runId: "run-1" });
  bus.emit({ type: "diagnostic.heartbeat", active: 3, waiting: 1, queued: 2, webhooks: { received: 4, processed: 3, errors: 1 } });
  bus.emit({
    type: "tool.loop",
    sessionId: "session-456",
    toolName: "Read",
    detector: "ping_pong",
    action: "block",
    level: "critical",
    count: 6,
    message: "loop detected",
  });

  assert.equal(telemetry.metricCounters.get("openclaw.webhook.received")?.calls.length, 1);
  assert.equal(telemetry.metricCounters.get("openclaw.webhook.error")?.calls.length, 1);
  assert.equal(telemetry.metricCounters.get("openclaw.message.queued")?.calls.length, 1);
  assert.equal(telemetry.metricCounters.get("openclaw.message.processed")?.calls.length, 1);
  assert.equal(telemetry.metricCounters.get("openclaw.queue.lane.enqueue")?.calls.length, 1);
  assert.equal(telemetry.metricCounters.get("openclaw.queue.lane.dequeue")?.calls.length, 1);
  assert.equal(telemetry.metricCounters.get("openclaw.session.state")?.calls.length, 1);
  assert.equal(telemetry.metricCounters.get("openclaw.session.stuck")?.calls.length, 1);
  assert.equal(telemetry.metricCounters.get("openclaw.run.attempt")?.calls.length, 1);
  assert.equal(telemetry.metricCounters.get("openclaw.tool.loop")?.calls.length, 1);
  assert.equal(telemetry.metricHistograms.get("openclaw.webhook.duration_ms")?.calls[0]?.value, 55);
  assert.equal(telemetry.metricHistograms.get("openclaw.message.duration_ms")?.calls[0]?.value, 75);
  assert.equal(telemetry.metricHistograms.get("openclaw.queue.wait_ms")?.calls[0]?.value, 14);
  assert.equal(telemetry.metricHistograms.get("openclaw.session.stuck_age_ms")?.calls[0]?.value, 120_000);

  const spanNames = telemetry.tracer.spans.map((entry) => entry.name);
  assert.ok(spanNames.includes("openclaw.webhook.processed"));
  assert.ok(spanNames.includes("openclaw.webhook.error"));
  assert.ok(spanNames.includes("openclaw.message.processed"));
  assert.ok(spanNames.includes("openclaw.session.stuck"));
  assert.ok(spanNames.includes("openclaw.tool.loop"));

  const toolLoopSpan = telemetry.tracer.spans.find((entry) => entry.name === "openclaw.tool.loop")?.span;
  assert.equal(toolLoopSpan?.statuses.at(-1)?.message, "loop detected");

  unsubscribe();
  setOnDiagnosticEventForTest(null);
});