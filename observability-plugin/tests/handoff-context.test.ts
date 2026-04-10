import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanupHandoff,
  getHandoffSequence,
  onAgentEnd,
  onAgentStart,
  registerAgentSpan,
  seedHandoffState,
} from "../src/handoff.ts";
import {
  extractContextFromHeaders,
  getContextHeaders,
  HEADER_AGENT_SEQUENCE,
  HEADER_FORK_BRANCH_INDEX,
  HEADER_FORK_ID,
  HEADER_FORK_PARENT_SEQ,
  HEADER_LAST_AGENT_NAME,
  HEADER_LAST_AGENT_SPAN_ID,
  HEADER_LAST_AGENT_TRACE_ID,
  HEADER_SESSION_ID,
} from "../src/context-propagation.ts";
import { MockSpan, createSpanContext } from "./helpers.ts";

test("handoff tracks sequence and previous agent across turns", () => {
  cleanupHandoff("handoff-1");
  const firstStart = onAgentStart("handoff-1", "planner");
  const firstSpan = new MockSpan(createSpanContext("31"));
  registerAgentSpan("handoff-1", "planner", firstSpan as any, firstStart.sequence, firstStart.previousAgentName);
  onAgentEnd("handoff-1", "planner", firstSpan as any);

  const secondStart = onAgentStart("handoff-1", "coder");

  assert.equal(firstStart.sequence, 1);
  assert.equal(secondStart.sequence, 2);
  assert.equal(secondStart.previousAgentName, "planner");
  assert.equal(secondStart.attributes["ioa_observe.agent.previous"], "planner");
  assert.equal(secondStart.links[0]?.attributes?.["link.type"], "agent_handoff");
  assert.equal(getHandoffSequence("handoff-1"), 1);

  cleanupHandoff("handoff-1");
});

test("handoff can be seeded for a spawned session exactly once", () => {
  cleanupHandoff("handoff-2");
  const seeded = seedHandoffState("handoff-2", {
    lastAgentName: "planner",
    sequence: 4,
    lastAgentSpanContext: createSpanContext("32", "b".repeat(32)),
  });
  const seededAgain = seedHandoffState("handoff-2", {
    lastAgentName: "ignored",
    sequence: 9,
    lastAgentSpanContext: createSpanContext("33", "c".repeat(32)),
  });
  const next = onAgentStart("handoff-2", "subagent");

  assert.equal(seeded, true);
  assert.equal(seededAgain, false);
  assert.equal(next.sequence, 5);
  assert.equal(next.previousAgentName, "planner");

  cleanupHandoff("handoff-2");
});

test("context propagation includes and restores agent linking headers", () => {
  const spanContext = createSpanContext("34", "d".repeat(32));
  const headers = getContextHeaders("session-ctx", {
    lastAgentName: "planner",
    lastAgentSpanContext: spanContext,
    agentSequence: 3,
    forkId: "fork-1",
    forkParentSeq: 2,
    forkBranchIndex: 1,
  });

  assert.equal(headers[HEADER_SESSION_ID], "session-ctx");
  assert.equal(headers[HEADER_LAST_AGENT_NAME], "planner");
  assert.equal(headers[HEADER_LAST_AGENT_SPAN_ID], spanContext.spanId);
  assert.equal(headers[HEADER_LAST_AGENT_TRACE_ID], spanContext.traceId);
  assert.equal(headers[HEADER_AGENT_SEQUENCE], "3");
  assert.equal(headers[HEADER_FORK_ID], "fork-1");
  assert.equal(headers[HEADER_FORK_PARENT_SEQ], "2");
  assert.equal(headers[HEADER_FORK_BRANCH_INDEX], "1");

  const extracted = extractContextFromHeaders(headers);
  assert.deepEqual(extracted, {
    sessionId: "session-ctx",
    lastAgentSpanId: spanContext.spanId,
    lastAgentTraceId: spanContext.traceId,
    lastAgentName: "planner",
    agentSequence: 3,
    forkId: "fork-1",
    forkParentSeq: 2,
    forkBranchIndex: 1,
  });
});