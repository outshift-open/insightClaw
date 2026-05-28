//  Copyright (c) 2026 Cisco Systems, Inc. and its affiliates
//  SPDX-License-Identifier: Apache-2.0

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

function assertUuid(value: unknown): asserts value is string {
  assert.equal(typeof value, "string");
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
}

test("session lifecycle emits session.start and session.end around explicit end", () => {
  stopSessionWatcher();
  const tracer = new MockTracer();
  startSessionWatcher(tracer as any, createLogger(), 10_000);

  touchSession("session-1", context.active(), "workflow-a");
  assert.equal(activeSessionCount(), 1);

  endSession("session-1");

  assert.equal(activeSessionCount(), 0);
  assert.equal(tracer.spans.length, 2);
  assert.equal(tracer.spans[0]?.name, "session.start");
  const sessionId = tracer.spans[0]?.options.attributes["session.id"];
  assertUuid(sessionId);
  assert.notEqual(sessionId, "session-1");
  assert.equal(tracer.spans[0]?.options.attributes["openclaw.session.key"], "session-1");
  assert.equal(tracer.spans[1]?.name, "session.end");
  assert.equal(tracer.spans[1]?.options.attributes["session.id"], sessionId);
  assert.equal(tracer.spans[1]?.options.attributes["ioa_observe.workflow.name"], "workflow-a");

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
  assert.equal(tracer.spans.length, 1);
  assert.equal(tracer.spans[0]?.name, "session.start");

  stopSessionWatcher();
});

test("spawned runtime sessions can alias the parent workflow session id", () => {
  stopSessionWatcher();
  const tracer = new MockTracer();
  startSessionWatcher(tracer as any, createLogger(), 10_000);

  const parentSessionId = touchSession("session-parent", context.active(), "workflow-a");
  const childSessionId = touchSession("session-child", context.active(), undefined, parentSessionId);

  assert.equal(childSessionId, parentSessionId);
  assert.equal(activeSessionCount(), 1);
  assert.equal(tracer.spans.length, 1);

  endSession("session-child");
  assert.equal(activeSessionCount(), 1);
  assert.equal(tracer.spans.length, 1);

  endSession("session-parent");
  assert.equal(activeSessionCount(), 0);
  assert.equal(tracer.spans.length, 2);
  assert.equal(tracer.spans[1]?.options.attributes["session.id"], parentSessionId);

  stopSessionWatcher();
});