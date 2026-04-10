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
