import test from "node:test";
import assert from "node:assert/strict";
import { context } from "@opentelemetry/api";

import {
  activeSessionCount,
  endSession,
  removeSession,
  startSessionWatcher,
  stopSessionWatcher,
  touchSession,
} from "../src/session-lifecycle.ts";
import { MockTracer } from "./helpers.ts";

function createLogger() {
  return {
    info() {},
    debug() {},
  };
}

test("session lifecycle tracks sessions and emits session.end on explicit end", () => {
  stopSessionWatcher();
  const tracer = new MockTracer();
  startSessionWatcher(tracer as any, createLogger(), 10_000);

  touchSession("session-1", context.active(), "workflow-a");
  assert.equal(activeSessionCount(), 1);

  endSession("session-1");

  assert.equal(activeSessionCount(), 0);
  assert.equal(tracer.spans.length, 1);
  assert.equal(tracer.spans[0]?.name, "session.end");
  assert.equal(tracer.spans[0]?.options.attributes["session.id"], "session-1");
  assert.equal(tracer.spans[0]?.options.attributes["ioa_observe.workflow.name"], "workflow-a");

  stopSessionWatcher();
});

test("session lifecycle updates existing sessions and removes without emission", () => {
  stopSessionWatcher();
  const tracer = new MockTracer();
  startSessionWatcher(tracer as any, createLogger(), 10_000);

  touchSession("session-2", context.active(), "workflow-a");
  touchSession("session-2", context.active(), "workflow-b");
  assert.equal(activeSessionCount(), 1);

  removeSession("session-2");

  assert.equal(activeSessionCount(), 0);
  assert.equal(tracer.spans.length, 0);

  stopSessionWatcher();
});