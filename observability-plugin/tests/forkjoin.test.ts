import test from "node:test";
import assert from "node:assert/strict";

import { cleanupForkJoin, consumeJoin, finalizeAgentTurn, registerToolSpan } from "../src/forkjoin.ts";
import { MockSpan, createSpanContext } from "./helpers.ts";

test("forkjoin leaves single tool turns unannotated", () => {
  const span = new MockSpan(createSpanContext("21"));

  const attrs = registerToolSpan("session-a", "Read", span as any, "planner", 1);
  const join = finalizeAgentTurn("session-a");

  assert.equal(attrs, null);
  assert.equal(join, null);
});

test("forkjoin annotates concurrent tools and exposes a join for the next agent", () => {
  const first = new MockSpan(createSpanContext("22"));
  const second = new MockSpan(createSpanContext("23"));

  const firstAttrs = registerToolSpan("session-b", "Read", first as any, "planner", 2);
  const secondAttrs = registerToolSpan("session-b", "Write", second as any, "planner", 2);
  const finalized = finalizeAgentTurn("session-b");
  const join = consumeJoin("session-b");

  assert.equal(firstAttrs, null);
  assert.equal(secondAttrs?.["ioa_observe.fork.branch_index"], 1);
  assert.equal(first.attributes.get("ioa_observe.fork.branch_index"), 0);
  assert.equal(first.attributes.get("ioa_observe.fork.id"), secondAttrs?.["ioa_observe.fork.id"]);
  assert.equal(finalized?.branchCount, 2);
  assert.equal(finalized?.branchLinks.length, 2);
  assert.equal(join?.attributes["ioa_observe.join.branch_count"], 2);
  assert.equal(join?.links.length, 2);
  assert.equal(consumeJoin("session-b"), null);
});

test("forkjoin cleanup clears pending and completed fork state", () => {
  const first = new MockSpan(createSpanContext("24"));
  const second = new MockSpan(createSpanContext("25"));

  registerToolSpan("session-c", "Read", first as any, "planner", 3);
  registerToolSpan("session-c", "Write", second as any, "planner", 3);
  finalizeAgentTurn("session-c");
  cleanupForkJoin("session-c");

  assert.equal(consumeJoin("session-c"), null);
});