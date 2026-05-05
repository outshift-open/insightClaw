# OpenClaw Deep Observability Plugin Overview

OpenClaw already exposes useful diagnostic facts such as model usage, queue state, webhook processing, and session health. What it does not provide on its own is a single connected story for one request:

* which inbound message started the work
* which agent handled it
* which tools were called
* whether subagents were spawned or parallel branches occurred
* what the model call cost
* whether the response was actually sent back out
  

This plugin closes that gap by combining three telemetry paths:

1. Typed OpenClaw lifecycle hooks for request, agent, tool, and outbound message flow.
2. Event-stream hooks for control-plane events such as session reset and gateway startup.
3. OpenClaw diagnostics events for accurate model usage, cost, queue, webhook, and stuck-session signals.
  

The result is a unified observability layer with connected traces for request forensics, metrics for dashboards and alerts, and optional provider SDK auto-instrumentation for GenAI calls.

## Problem We Are Solving

Five operational questions:

1. What happened to a specific request from the time it arrived until a response was sent?
2. Which agent, tool, or subagent caused latency or failure?
3. What did the request cost in tokens and dollars?
4. Is the gateway healthy, backlogged, or stuck?
5. Are there unsafe or abnormal execution patterns happening inside the control plane?


Using only disconnected diagnostic events is not enough for these questions because the events tell us that something happened, but not always how the work was connected across agent turns, tools, and outbound delivery.

Using only provider SDK auto-instrumentation is also not enough because SDK spans do not understand OpenClaw concepts such as session keys, agent turns, tool calls, handoffs, fork/join behavior, or control-plane commands.

The plugin therefore treats OpenClaw itself as the source of truth for workflow structure and uses diagnostics as the source of truth for usage accounting and gateway health.

## Solution Approach

The implementation is intentionally split into two layers plus an optional third:

### Layer 1: Hook-based workflow tracing

The plugin registers typed hooks through `api.on(...)` to model the request lifecycle. This layer creates the connected trace hierarchy:

```
openclaw.request └── openclaw.agent.turn ├── tool.Read ├── tool.exec ├── tool.sessions_spawn └── provider SDK spans (optional, via preload instrumentation) └── openclaw.message.sent
```

This gives us the workflow structure that stakeholders care about.

### Layer 2: Diagnostics-driven enrichment and control-plane telemetry

The plugin subscribes to OpenClaw diagnostic events through `onDiagnosticEvent` from the plugin SDK. This is how it receives accurate:

* model token counts
* model/provider identity
* estimated cost
* context window usage
* webhook activity
* queue activity and wait times
* session state and stuck-session indicators
* run attempts and tool-loop warnings
  

These diagnostics are used in two ways:

* to enrich the active `openclaw.agent.turn` span with accurate model usage and cost
* to emit standalone metrics and diagnostic spans for gateway operations
  

### Layer 3: Optional provider SDK auto-instrumentation

If OpenClaw is started with `NODE_OPTIONS=--import ./instrumentation/preload.mjs`, the plugin can also include provider SDK spans for Anthropic, OpenAI, Bedrock, and Vertex AI.

This is optional. The plugin still emits its own hook-based request, agent, tool, and message spans even when SDK auto-instrumentation is not active.

## How We Use OpenClaw Hooks

### Typed hooks registered with `api.on(...)`

| Hook | What the plugin does | Telemetry emitted |
| :-- | :-- | :-- |
| message_received | Creates or reuses the root request span, captures inbound content when enabled, runs prompt-injection detection, and starts session tracking. | openclaw.request span, openclaw.messages.received counter. |
| message_sent | Creates a producer span for the outbound response and captures response content when enabled. | openclaw.message.sent span, openclaw.messages.sent counter. |
| before_agent_start | Creates the openclaw.agent.turn child span, attaches handoff and join links, seeds child-session handoff state, and registers the active span for diagnostics enrichment. | openclaw.agent.turn span. |
| before_model_resolve | Registered but currently acts as a placeholder. | No telemetry today. |
| before_prompt_build | Registered but currently acts as a placeholder. | No telemetry today. |
| before_tool_call | Starts the tool span, captures tool input when enabled, records tool invocation count, runs sensitive-file and dangerous-command detection, and marks parallel branches for fork detection. | tool.<toolName> span start, openclaw.tool.calls counter,. |
| tool_result_persist | Looks up the pending tool span, attaches result metadata and captured output, marks tool errors, closes the span, and extracts child-agent IDs from sessions_spawn. | tool.<toolName> span completion, openclaw.tool.errors counter when the result is flagged as an error. |
| agent_end | Finalizes the agent span and the root request span, attaches tokens/model/provider/cost/context, records duration, closes fork groups, clears active state, and cleans up context. | openclaw.agent.turn span completion, openclaw.request span completion, openclaw.agent.turn_duration histogram, token and request counters when diagnostics data was not already available. |

### Event-stream hooks registered with `api.registerHook(...)`

| Event hook | What the plugin does | Telemetry emitted |
| :-- | :-- | :-- |
| command:new | Records the command event and ends the operational session. | openclaw.command.new span, openclaw.session.resets counter, session.end span. |
| command:reset | Records the command event and ends the operational session. | openclaw.command.reset span, openclaw.session.resets counter, session.end span. |
| command:stop | Records the command event. | openclaw.command.stop span. |
| gateway:startup | Records that the gateway started. | openclaw.gateway.startup span. |

### Diagnostics event subscription

The plugin also subscribes to the diagnostics event bus and consumes these event types:

* `model.usage`
* `webhook.received`
* `webhook.processed`
* `webhook.error`
* `message.queued`
* `message.processed`
* `queue.lane.enqueue`
* `queue.lane.dequeue`
* `session.state`
* `session.stuck`
* `run.attempt`
* `diagnostic.heartbeat`
* `tool.loop`
  

This is not a duplicate hook system. It is the diagnostics path that complements the workflow hooks with accurate usage accounting and control-plane health signals.

## Trace Model

### Core lifecycle spans

| Span | Source | Parenting | When emitted | Why it exists |
| :-- | :-- | :-- | :-- | :-- |
| openclaw.request | message_received or fallback creation during before_agent_start | Root span | On the first stable inbound session/conversation event for a request. | Represents the full message-to-response workflow. |
| openclaw.agent.turn | before_agent_start | Child of openclaw.request | When an agent begins work on a session. | Represents one agent turn and is the anchor for model usage, handoffs, and tools. |
| tool.<toolName> | before_tool_call + tool_result_persist | Child of openclaw.agent.turn | Starts before the tool runs and ends when the persisted result arrives. | Represents tool execution with input/output, error state. |
| openclaw.message.sent | message_sent | Child of openclaw.request | When OpenClaw emits the outbound message hook. | Confirms response delivery was attempted. |
| session.end | Session watcher / explicit session end | Child of stored session root context | On idle timeout, process exit, or explicit command:new / command:reset. | Marks operational session completion. |
| openclaw.command.new | Event-stream hook | Root or child of active request context if present | On command event. | Makes operator-driven session changes visible in traces. |
| openclaw.command.reset | Event-stream hook | Root or child of active request context if present | On command event. | Same as above. |
| openclaw.command.stop | Event-stream hook | Root or child of active request context if present | On command event. | Records stop operations. |
| openclaw.gateway.startup | Event-stream hook | Root span | On gateway startup. | Proves the plugin saw the control plane start. |

### Diagnostic spans

| Span | Source event | Parenting | When emitted | Why it exists |
| :-- | :-- | :-- | :-- | :-- |
| openclaw.model.usage | model.usage | Linked to the active openclaw.agent.turn when available | When diagnostics report model usage. | Captures accurate model usage, provider, model, and cost timing. |
| openclaw.webhook.processed | webhook.processed | Root span | When a webhook finishes processing. | Makes ingress processing visible in traces. |
| openclaw.webhook.error | webhook.error | Root span | When ingress processing fails. | Captures webhook failures as error spans. |
| openclaw.message.processed | message.processed | Root span | When a queued message finishes processing. | Exposes downstream processing outcomes and duration. |
| openclaw.session.stuck | session.stuck | Root span | When diagnostics flag a stuck session. | Converts a health issue into a traceable error signal. |
| openclaw.tool.loop | tool.loop | Child of active openclaw.agent.turn when available | When loop detection fires. | Surfaces recursive or blocked tool-loop behavior. |

### Optional provider SDK spans

When preload-based SDK auto-instrumentation is enabled, provider SDK calls produce their own OTel spans under the active agent context. These spans are optional and depend on runtime startup configuration rather than plugin hook registration.

## Advanced Trace Features

Beyond simple parent-child spans, the plugin adds correlation features that matter in multi-agent systems.

## Session Model

This plugin intentionally defines a **session** differently from OpenClaw.

### Our session vs. OpenClaw's session identifiers

OpenClaw emits runtime identifiers such as `sessionKey`, `conversationId`, and sometimes a diagnostic `sessionId`. We treat those values as **correlation keys** that tell us which request, agent turn, tool call, or model call belongs to the same running conversation context.

The plugin then creates its own workflow-level `session.id` as a UUID. That `session.id` is the lifecycle boundary for `session.start` and `session.end` spans.

In practice:

* `openclaw.session.key` is the stable runtime key we use to correlate spans.
* `openclaw.runtime.session.id` is only attached when OpenClaw diagnostics provide a separate runtime session identifier.
* `session.id` is **our** session identifier and is generated by the plugin.
  

So the OpenClaw identifiers tell us **which runtime stream an event belongs to**, while the plugin `session.id` tells us **which workflow session lifecycle we are currently tracking for that runtime stream**.

### When our session starts

Our session starts the first time we observe activity for a stable runtime session key.

Most commonly that happens when we create the root `openclaw.request` span from an inbound message. If the inbound hook does not provide enough context early enough, the session can also be created lazily from later activity such as:

* `before_agent_start`
* `before_tool_call`
* `llm_input`
* `message_sent`
  

That means the session start is based on the **first traced activity we can reliably associate with a runtime session key**, not on a dedicated OpenClaw "session created" event.

### When our session ends

Our session does **not** end when a single request finishes. An `openclaw.request` span represents one traced request/turn, while `session.id` can outlive multiple request spans as long as the same runtime session stays active.

We end the session in three cases:

1. Explicit command end: when OpenClaw emits `command:new` or `command:reset` for that runtime session key, we call `endSession(...)` and emit `session.end`.
2. Idle timeout: if no new activity touches the session for the configured timeout (5 minutes), we emit `session.end` automatically.
3. Process shutdown: on `beforeExit`, `SIGINT`, or `SIGTERM`, we flush `session.end` for any still-active sessions.
  

By default, the idle timeout is 5 minutes and the watcher checks for expired sessions every 30 seconds.

### End-of-session heuristic

The heuristic is simple:

* every traced activity for a runtime session key updates `lastActivityAt`
* a background watcher closes sessions whose `lastActivityAt` is older than the idle threshold
  

This makes session end a best-effort workflow boundary rather than a guaranteed business event from OpenClaw itself.

Two implications follow from that design:

* `session.ended_at` reflects the last observed activity time, not necessarily the exact wall-clock time when the watcher ran.
* `agent_end` closes the current request/agent spans, but it does not by itself close the workflow session; a later turn in the same runtime session can continue under the same `session.id` until one of the end conditions above happens.
  

### Parallel and multi-agent behavior

Parallel execution does not automatically imply multiple sessions. The plugin uses the runtime session key as the boundary.

**Parallel work inside one runtime session**

If one agent runs multiple tool calls concurrently under the same runtime session key, we keep a single `session.id`. The tool branches are annotated with fork metadata and the next joining agent span is annotated with join metadata, but all of those spans still belong to the same plugin session.

**Sequential or parallel agents in the same runtime session**

If agent A hands off to agent B while staying in the same runtime session key, both agent turns remain in the same plugin session. We represent the relationship with handoff links and sequence attributes rather than by creating a new session.

**Spawned subagents with a new runtime session key**

If a subagent runs under a different runtime session key, the plugin creates a new `session.id` for that child runtime session. We then link the child root/agent spans back to the spawning tool and previous agent using span links (`agent_spawn`, `agent_handoff`), but lifecycle tracking is independent.

This means multiple subagents running in parallel can produce multiple concurrent plugin sessions, each with its own `session.id`, as long as OpenClaw gives them distinct runtime session keys.

## Agent handoff links

When one agent turn follows another in the same session, the next `openclaw.agent.turn` span receives:

* a span link with `link.type=agent_handoff`
* `ioa_observe.agent.sequence`
* `ioa_observe.agent.previous`
  

This shows the execution chain even when the turns are not simple parent-child nesting.

### Spawned subagent links

When the `sessions_spawn` tool creates a child agent, the child request span is seeded with:

* a span link to the spawning tool span with `link.type=agent_spawn`
* a span link back to the source agent with `link.type=agent_handoff`
  

This is how the plugin preserves cross-session lineage.

## Fork and join annotations

When multiple tools execute within the configured fork window for the same agent turn, the plugin annotates them as fork branches and annotates the next agent turn as the join.

Fork attributes include:

* `ioa_observe.fork.id`
* `ioa_observe.fork.branch_index`
* `ioa_observe.fork.parent_name`
* `ioa_observe.fork.parent_sequence`
  

Join attributes include:

* `ioa_observe.join.fork_id`
* `ioa_observe.join.branch_count`
  

## Payload Capture Behavior

If `captureContent=true`, the plugin stores request, agent, tool, and outbound message payloads on spans. Captured content is truncated to 4096 characters.

This applies to:

* inbound request input on `openclaw.request`
* agent input and output on `openclaw.agent.turn`
* tool input and output on `tool.<toolName>`
* outbound message output on `openclaw.message.sent`
  

If `captureContent=false`, the span structure and counters still exist, but payload text is not exported.

## Operational Metric Semantics

Most counters receive periodic zero-value updates at the metrics export interval to keep time series alive in backends that otherwise drop idle counters.
  

## Operational Metrics We Emit Today

### Core workflow metrics

| Metric | Type | When emitted | Notes |
| :-- | :-- | :-- | :-- |
| openclaw.messages.received | Counter | On every message_received hook. | Tagged with message channel. |
| openclaw.messages.sent | Counter | On every message_sent hook. | Tagged with message channel. |
| openclaw.tool.calls | Counter | On every before_tool_call hook. | Tagged with tool name and session key. |
| openclaw.tool.errors | Counter | On tool_result_persist when the persisted tool result is marked as an error. | Tagged with tool name. |
| openclaw.session.resets | Counter | On command:new and command:reset. | Tagged with command source. |
| openclaw.llm.requests | Counter | On every model.usage diagnostics event, or on agent_end if diagnostics data was not available and usage was recovered from messages. | Tagged with model and provider context when available. |
| openclaw.llm.tokens.prompt | Counter | On model.usage for input tokens and cache tokens, or on agent_end fallback without diagnostics. | Cache read and cache write tokens are also added here with token.type dimensions during diagnostics-driven emission. |
| openclaw.llm.tokens.completion | Counter | On model.usage for output tokens, or on agent_end fallback without diagnostics. | Tagged with model and agent when available. |
| openclaw.llm.tokens.total | Counter | On model.usage total tokens, or on agent_end fallback without diagnostics. | Represents total token consumption. |
| openclaw.agent.turn_duration | Histogram | On agent_end when durationMs is provided. | Tagged with model and agent ID. |
| openclaw.llm.duration | Histogram | On model.usage when diagnostics include durationMs. | Measures model request duration, not full turn duration. |
| openclaw.cost.usd | Counter | On model.usage when costUsd is present and greater than zero. | Diagnostics-driven cost signal. |

### Diagnostics-driven gateway metrics

| Metric | Type | When emitted | Notes |
| :-- | :-- | :-- | :-- |
| openclaw.webhook.received | Counter | On webhook.received. | Tagged with channel and webhook/update type. |
| openclaw.webhook.error | Counter | On webhook.error. | Tagged with channel and webhook/update type. |
| openclaw.webhook.duration_ms | Histogram | On webhook.processed when durationMs is available. | Measures ingress processing duration. |
| openclaw.message.queued | Counter | On message.queued. | Tagged with channel and source. |
| openclaw.message.processed | Counter | On message.processed. | Tagged with channel and outcome. |
| openclaw.message.duration_ms | Histogram | On message.processed when durationMs is available. | Measures queued-message processing duration. |
| openclaw.queue.depth | Histogram | On message.queued from queueDepth, on queue.lane.enqueue / queue.lane.dequeue from queueSize, and on diagnostic.heartbeat for queued/active/waiting snapshots. | This is the main backlog pressure metric. |
| openclaw.queue.wait_ms | Histogram | On queue.lane.dequeue when waitMs is provided. | Measures time spent waiting in the queue. |
| openclaw.queue.lane.enqueue | Counter | On queue.lane.enqueue. | Tagged with lane. |
| openclaw.queue.lane.dequeue | Counter | On queue.lane.dequeue. | Tagged with lane. |
| openclaw.session.state | Counter | On session.state. | Tagged with state and optional reason. |
| openclaw.session.stuck | Counter | On session.stuck. | Tagged with state. |
| openclaw.session.stuck_age_ms | Histogram | On session.stuck when ageMs is available. | Measures how long sessions have been stuck. |
| openclaw.run.attempt | Counter | On run.attempt. | Tagged with attempt number. |
| openclaw.tool.loop | Counter | On tool.loop. | Tagged with tool, detector, action, and severity level. |

### Memory-events metrics

| Metric | Type | When emitted | Notes |
| :-- | :-- | :-- | :-- |
| openclaw.memory.search_hit | Counter | On after_tool_call/tool_result_persist - memory_search | Only if memory_search returns some result |
| openclaw.memory.search_miss | Counter | On after_tool_call/tool_result_persist - memory_search with NO results | Only if memory_search returns NO result |
| openclaw.memory.edit_events | Counter | On after_tool_call/tool_result_persist - edit | Only if edit performed on long-term memory files (heuristics) |
| openclaw.memory.read_events | Counter | On after_tool_call/tool_result_persist - read | Only if read performed on long-term memory files (heuristics) |
| openclaw.memory.write_events | Counter | On after_tool_call/tool_result_persist - write | Only if write performed on long-term memory files (heuristics) |
| openclaw.memory.read_duration | Histogram | On after_tool_call/tool_result_persist - read | Only if read performed on long-term memory files (heuristics) |
| openclaw.memory.write_duration | Histogram | On after_tool_call/tool_result_persist - write | Only if write performed on long-term memory files (heuristics) |
| openclaw.memory.edit_duration | Histogram | On after_tool_call/tool_result_persist - edit | Only if edit performed on long-term memory files (heuristics) |

Note that some additional counters/duration relative to memory\_search and memory\_get can be derived by tool\_call counters, filtering on tool\_name - they do not require any additional processing/ heuristics.

## Derived Metrics (support in progress)

### Context assembly

| Metric | Type | Description | Notes |
| :-- | :-- | :-- | :-- |
| Context Source Composition Ratio | Histogram | Fraction of final context contributed by user prompt, system prompt, agent soul, memory (short/long‑term), tools | Heuristics could be applied to determine the source of data. Not all the sources may be supported |
| Context Assembly Latency | TBD | Time to collect, filter, prioritize, and assemble context | Based on context preparation span |
| Downstream Context Disclosure Ratio | TBD | % of parent context passed to sub‑agents | Based on heuristics to approximate context-reuse |
| Context Sharing | TBD | How many agent turns reuse identical or near‑identical context | Based on heuristics to approximate content-reuse |

### Memory Lifecycle

| Metric | Type | Description | Notes |
| :-- | :-- | :-- | :-- |
| Memory Volatile Index | Histogram | Frequency of edits/overwrites to same memory item | Based on heuristics to identify changes in memory |
| Memory Fragmentation Score (openclaw.memory.search_fragmentation) | Histogram | Dispersion of relevant memory across files/items | Supported |

### Routing and Delegation

| Metric | Type | Description | Notes |
| :-- | :-- | :-- | :-- |
| Parallelisation Score | TBD | Ratio processing time of all the agents and the session duration |  |

Additional derived metrics could be available, but they require more investigation.

## Operational Boundaries

* SDK-level provider spans require preload-based runtime configuration and are not guaranteed in every deployment.