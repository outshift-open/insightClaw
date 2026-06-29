//  Copyright (c) 2026 Cisco Systems, Inc. and its affiliates
//  SPDX-License-Identifier: Apache-2.0

/**
 * Observe Span Kinds — semantic span kind constants from the AGNTCY schema.
 *
 * Ported from agntcy/observe SDK (ioa_observe.sdk.utils.const).
 * These provide richer span type information than OTel's built-in SpanKind,
 * allowing backends to distinguish workflow, agent, tool, and task spans.
 */

// ── Span Kind Values ───────────────────────────────────────────────

export const ObserveSpanKind = {
  WORKFLOW: "workflow",
  AGENT: "agent",
  TOOL: "tool",
  TASK: "task",
  GRAPH: "graph",
} as const;

export type ObserveSpanKindValue = (typeof ObserveSpanKind)[keyof typeof ObserveSpanKind];

// ── Attribute Keys ─────────────────────────────────────────────────

/** The kind of span: workflow, agent, tool, task, graph */
export const ATTR_OBSERVE_SPAN_KIND = "ioa_observe.span.kind";

/** Input to the entity (plain text or JSON) */
export const ATTR_OBSERVE_ENTITY_INPUT = "ioa_observe.entity.input";

/** Output from the entity */
export const ATTR_OBSERVE_ENTITY_OUTPUT = "ioa_observe.entity.output";

/** Name of the entity */
export const ATTR_OBSERVE_ENTITY_NAME = "ioa_observe.entity.name";

/** Version of the entity */
export const ATTR_OBSERVE_ENTITY_VERSION = "ioa_observe.entity.version";

/** Name of the parent workflow */
export const ATTR_OBSERVE_WORKFLOW_NAME = "ioa_observe.workflow.name";

/** Agent sequence in execution chain */
export const ATTR_OBSERVE_AGENT_SEQUENCE = "ioa_observe.agent.sequence";

/** Previous agent name in execution chain */
export const ATTR_OBSERVE_AGENT_PREVIOUS = "ioa_observe.agent.previous";

/** Fork group ID */
export const ATTR_OBSERVE_FORK_ID = "ioa_observe.fork.id";

/** Branch index within a fork group */
export const ATTR_OBSERVE_FORK_BRANCH_INDEX = "ioa_observe.fork.branch_index";

/** Fork parent agent name */
export const ATTR_OBSERVE_FORK_PARENT_NAME = "ioa_observe.fork.parent_name";

/** Fork parent sequence */
export const ATTR_OBSERVE_FORK_PARENT_SEQ = "ioa_observe.fork.parent_sequence";

/** Join fork ID (on the joining span) */
export const ATTR_OBSERVE_JOIN_FORK_ID = "ioa_observe.join.fork_id";

/** Number of branches joined */
export const ATTR_OBSERVE_JOIN_BRANCH_COUNT = "ioa_observe.join.branch_count";

// ── OTel GenAI Semconv — primary fields ───────────────────────────

/** gen_ai.workflow.name — name of the workflow on workflow spans. */
export const ATTR_GEN_AI_WORKFLOW_NAME = "gen_ai.workflow.name";

/** gen_ai.input.messages — schema-compliant JSON array of input messages. */
export const ATTR_GEN_AI_INPUT_MESSAGES = "gen_ai.input.messages";

/** gen_ai.output.messages — schema-compliant JSON array of output messages. */
export const ATTR_GEN_AI_OUTPUT_MESSAGES = "gen_ai.output.messages";

/** gen_ai.tool.call.arguments — tool call input arguments (object or JSON string). */
export const ATTR_GEN_AI_TOOL_CALL_ARGUMENTS = "gen_ai.tool.call.arguments";

/** gen_ai.tool.call.result — tool call result (object or JSON string). */
export const ATTR_GEN_AI_TOOL_CALL_RESULT = "gen_ai.tool.call.result";

/** gen_ai.provider.name — AI provider identity (replaces deprecated gen_ai.system). */
export const ATTR_GEN_AI_PROVIDER_NAME = "gen_ai.provider.name";

/** gen_ai.usage.cache_read.input_tokens — tokens served from cache on input (current registry name). */
export const ATTR_GEN_AI_CACHE_READ_INPUT_TOKENS = "gen_ai.usage.cache_read.input_tokens";

/** gen_ai.usage.cache_creation.input_tokens — tokens written to cache on input (current registry name). */
export const ATTR_GEN_AI_CACHE_CREATION_INPUT_TOKENS = "gen_ai.usage.cache_creation.input_tokens";

/**
 * Apply span kind attributes to a span.
 */
export function setSpanKind(
  span: { setAttribute: (key: string, value: string) => void },
  kind: ObserveSpanKindValue,
  entityName?: string
): void {
  span.setAttribute(ATTR_OBSERVE_SPAN_KIND, kind);
  if (entityName) {
    span.setAttribute(ATTR_OBSERVE_ENTITY_NAME, entityName);
  }
}
