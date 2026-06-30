# Operational Metrics We Emit Today

The tables below list the metric attributes exactly as they are emitted by the current source.

For the core counters created in `observability-plugin/src/telemetry.ts`, the plugin also emits periodic zero-value heartbeat datapoints with the attribute `openclaw.idle=true` to keep those timeseries alive during idle periods. That heartbeat applies to these counters only: `openclaw.llm.requests`, `openclaw.llm.errors`, `openclaw.llm.tokens.total`, `openclaw.llm.tokens.prompt`, `openclaw.llm.tokens.completion`, `openclaw.tool.calls`, `openclaw.tool.errors`, `openclaw.messages.received`, `openclaw.messages.sent`, `openclaw.session.resets`, `openclaw.memory.search_hit`, `openclaw.memory.search_miss`, `openclaw.memory.write_events`, `openclaw.memory.read_events`, and `openclaw.memory.edit_events`.

### Core workflow metrics

| Metric | Type | When emitted | Attributes emitted | Notes |
| :-- | :-- | :-- | :-- | :-- |
| openclaw.messages.received | Counter | On every `message_received` hook. | `openclaw.message.channel` | Heartbeat datapoints use only `openclaw.idle=true`. |
| openclaw.messages.sent | Counter | On every `message_sent` hook and inferred outbound completion path. | `openclaw.message.channel` | Heartbeat datapoints use only `openclaw.idle=true`. |
| openclaw.tool.calls | Counter | On every `before_tool_call` hook. | `tool.name`, `gen_ai.agent.id` | The code does not attach session metadata to this metric. |
| openclaw.tool.errors | Counter | When a tool result is marked as failed/error, or completed/accepted/yielded with a positive exit code. | `tool.name`, `gen_ai.agent.id` | Emitted from tool result handling in `observability-plugin/src/hooks.ts`. |
| openclaw.tool.duration | Histogram | When a tool span is closed in `after_tool_call` or `tool_result_persist`. | `tool.name`, `gen_ai.agent.id` | This metric is emitted today but was missing from the previous docs. |
| openclaw.session.resets | Counter | On `command:new` and `command:reset`. | `command.source` | Heartbeat datapoints use only `openclaw.idle=true`. |
| openclaw.llm.requests | Counter | On every `model.usage` diagnostics event, or on `agent_end` fallback if diagnostics usage was not available. | Diagnostics path: `gen_ai.response.model`, `openclaw.provider`, `openclaw.channel`. Fallback path: `gen_ai.response.model`, `gen_ai.agent.id`. | Heartbeat datapoints use only `openclaw.idle=true`. |
| openclaw.llm.tokens.prompt | Counter | On `model.usage` for input tokens and cache tokens, or on `agent_end` fallback without diagnostics. | Diagnostics path: `gen_ai.response.model`, `openclaw.provider`, `openclaw.channel`. Cache token datapoints also add `token.type=cache_read` or `token.type=cache_write`. Fallback path: `gen_ai.response.model`, `gen_ai.agent.id`. | The fallback path adds input plus cache tokens in a single datapoint, without `token.type`. |
| openclaw.llm.tokens.completion | Counter | On `model.usage` for output tokens, or on `agent_end` fallback without diagnostics. | Diagnostics path: `gen_ai.response.model`, `openclaw.provider`, `openclaw.channel`. Fallback path: `gen_ai.response.model`, `gen_ai.agent.id`. | Heartbeat datapoints use only `openclaw.idle=true`. |
| openclaw.llm.tokens.total | Counter | On `model.usage` total tokens, or on `agent_end` fallback without diagnostics. | Diagnostics path: `gen_ai.response.model`, `openclaw.provider`, `openclaw.channel`. Fallback path: `gen_ai.response.model`, `gen_ai.agent.id`. | Heartbeat datapoints use only `openclaw.idle=true`. |
| openclaw.agent.turn_duration | Histogram | On `agent_end` when `durationMs` is present. | `gen_ai.response.model`, `gen_ai.agent.id` | Measures full agent-turn duration. |
| openclaw.llm.duration | Histogram | On `model.usage` when diagnostics include `durationMs`. | `gen_ai.response.model`, `openclaw.provider`, `openclaw.channel` | Measures model request duration, not full turn duration. |
| openclaw.cost.usd | Counter | On `model.usage` when `costUsd` is present and greater than zero. | `gen_ai.response.model`, `openclaw.provider`, `openclaw.channel` | Diagnostics-driven cost signal. |

### Diagnostics-driven gateway metrics

| Metric | Type | When emitted | Attributes emitted | Notes |
| :-- | :-- | :-- | :-- | :-- |
| openclaw.webhook.received | Counter | On `webhook.received`. | `openclaw.channel`, `openclaw.webhook` | `openclaw.webhook` is the diagnostic `updateType`. |
| openclaw.webhook.error | Counter | On `webhook.error`. | `openclaw.channel`, `openclaw.webhook` | Error text is added to the diagnostic span, not to the metric. |
| openclaw.webhook.duration_ms | Histogram | On `webhook.processed` when `durationMs` is available. | `openclaw.channel`, `openclaw.webhook` | Measures ingress processing duration. |
| openclaw.message.queued | Counter | On `message.queued`. | `openclaw.channel`, `openclaw.source` | |
| openclaw.message.processed | Counter | On `message.processed`. | `openclaw.channel`, `openclaw.outcome` | |
| openclaw.message.duration_ms | Histogram | On `message.processed` when `durationMs` is available. | `openclaw.channel`, `openclaw.outcome` | Measures queued-message processing duration. |
| openclaw.queue.depth | Histogram | On `message.queued` from `queueDepth`, on `queue.lane.enqueue` / `queue.lane.dequeue` from `queueSize`, and on `diagnostic.heartbeat` for queued/active/waiting snapshots. | `message.queued` path: `openclaw.channel`, `openclaw.source`. Lane paths: `openclaw.lane`. Heartbeat path: `openclaw.channel=heartbeat`, `openclaw.metric` where the value is `queued`, `active`, or `waiting`. | This is the main backlog pressure metric. |
| openclaw.queue.wait_ms | Histogram | On `queue.lane.dequeue` when `waitMs` is provided. | `openclaw.lane` | Measures time spent waiting in the queue. |
| openclaw.queue.lane.enqueue | Counter | On `queue.lane.enqueue`. | `openclaw.lane` | |
| openclaw.queue.lane.dequeue | Counter | On `queue.lane.dequeue`. | `openclaw.lane` | |
| openclaw.session.state | Counter | On `session.state`. | `openclaw.state`, optional `openclaw.reason` | |
| openclaw.session.stuck | Counter | On `session.stuck`. | `openclaw.state` | Queue depth and age are added to the diagnostic span, not to the counter. |
| openclaw.session.stuck_age_ms | Histogram | On `session.stuck` when `ageMs` is available. | `openclaw.state` | Measures how long sessions have been stuck. |
| openclaw.run.attempt | Counter | On `run.attempt`. | `openclaw.attempt` | Numeric attempt number. |
| openclaw.tool.loop | Counter | On `tool.loop`. | `openclaw.tool`, `openclaw.detector`, `openclaw.action`, `openclaw.level` | Loop count, paired tool, and message are added to the diagnostic span, not to the counter. |

### Memory-events metrics

| Metric | Type | When emitted | Attributes emitted | Notes |
| :-- | :-- | :-- | :-- | :-- |
| openclaw.memory.search_hit | Counter | On `after_tool_call` or `tool_result_persist` for `memory_search` when the parsed results array is non-empty. | `tool.name`, `gen_ai.agent.id` | `tool.name` is `memory_search`. |
| openclaw.memory.search_miss | Counter | On `after_tool_call` or `tool_result_persist` for `memory_search` when the parsed results array is empty. | `tool.name`, `gen_ai.agent.id` | `tool.name` is `memory_search`. |
| openclaw.memory.edit_events | Counter | On `after_tool_call` or `tool_result_persist` for `edit`. | `tool.name`, `gen_ai.agent.id` | Only when the path heuristics classify the target as long-term memory: path contains `memory` or `memories` and ends with `.md`. |
| openclaw.memory.read_events | Counter | On `after_tool_call` or `tool_result_persist` for long-term-memory `read`, and also on every `memory_search`. | `tool.name`, `gen_ai.agent.id` | The current implementation increments `read_events` for `memory_search` as well as `read`. |
| openclaw.memory.write_events | Counter | On `after_tool_call` or `tool_result_persist` for `write`. | `tool.name`, `gen_ai.agent.id` | Only when the path heuristics classify the target as long-term memory. |
| openclaw.memory.read_duration | Histogram | On `after_tool_call` or `tool_result_persist` for long-term-memory `read`. | `tool.name`, `gen_ai.agent.id` | |
| openclaw.memory.write_duration | Histogram | On `after_tool_call` or `tool_result_persist` for long-term-memory `write`. | `tool.name`, `gen_ai.agent.id` | |
| openclaw.memory.edit_duration | Histogram | On `after_tool_call` or `tool_result_persist` for long-term-memory `edit`. | `tool.name`, `gen_ai.agent.id` | |

Note that some additional counters relative to `memory_search` and `memory_get` can be derived by filtering `openclaw.tool.calls` / `openclaw.tool.errors` by `tool.name`.

## Derived Metrics

### Context assembly

| Metric | Type | When emitted | Attributes emitted | Description |
| :-- | :-- | :-- | :-- | :-- |
| openclaw.context.system_size | Histogram | On `llm_input`. | `gen_ai.agent.id` | Bytes contributed by `systemPrompt`. |
| openclaw.context.prompt_size | Histogram | On `llm_input`. | `gen_ai.agent.id` | Bytes contributed by `prompt`. |
| openclaw.context.history_memory_size | Histogram | On `llm_input`. | `gen_ai.agent.id` | Bytes contributed by history entries recognized as memory-tool output. |
| openclaw.context.history_tool_size | Histogram | On `llm_input`. | `gen_ai.agent.id` | Bytes contributed by non-memory tool results in history. |
| openclaw.context.history_user_size | Histogram | On `llm_input`. | `gen_ai.agent.id` | Bytes contributed by user messages in history. |
| openclaw.context.history_other_size | Histogram | On `llm_input`. | `gen_ai.agent.id` | Bytes contributed by all other history entries. |
| openclaw.context.preparation_duration | Histogram | On `llm_input`. | `gen_ai.agent.id` | Time between the preferred agent lifecycle start hook (`before_model_resolve` or `before_prompt_build`) and `llm_input`; legacy `before_agent_start` is still supported as a fallback. |
| openclaw.agent.downstream_context_sharing | Histogram | On `llm_input`, when experimental metrics are enabled and parent context is available. | `gen_ai.agent.id` | Estimated overlap between the caller context and the sub-agent prompt. [Experimental] |
| openclaw.agent.novelty_score | Histogram | On `agent_end`, when experimental metrics are enabled and parent context is available. | `gen_ai.agent.id` | Estimated novelty of the sub-agent output relative to the caller context. [Experimental] |

### Memory Lifecycle

| Metric | Type | When emitted | Attributes emitted | Description |
| :-- | :-- | :-- | :-- | :-- |
| openclaw.memory.search_fragmentation | Histogram | On `after_tool_call` or `tool_result_persist` for `memory_search`, when the parsed results array is non-empty. | `tool.name`, `gen_ai.agent.id` | Measures how much the information is spread across different files, computed as `(uniquePaths - 1) / results.length`. |
| openclaw.memory.failure_rate | Histogram | When a long-term memory tool span closes and at least one long-term memory span exists in the session cache. | `openclaw.session.key`, `openclaw.metric.scope=session` | Session-level failure rate derived from cached long-term-memory tool spans. |

### Routing and Delegation

| Metric | Type | When emitted | Attributes emitted | Description |
| :-- | :-- | :-- | :-- | :-- |
| openclaw.session.parallelisation_score | Histogram | When a session ends and the session is not a heartbeat session. | `openclaw.session.key` | Ratio between the sum of recorded agent-turn durations and total session duration. Values above 1 are possible when work overlapped in time. |
| openclaw.session.repetition_score | Histogram | When a session ends and the session is not a heartbeat session. | `openclaw.session.key` | Average per-agent repetition score across non-root agents, based on prompt similarity between `openclaw.llm.call` inputs. |

Note: metrics flagged as [Experimental] are still at an early stage and not production-level. By default they are disabled in the plugin (must be enabled via `experimentalMetrics` configuration).

## Declared But Not Fully Wired

- `openclaw.llm.errors` is declared and receives only the zero-value heartbeat datapoints with `openclaw.idle=true`; I did not find any non-idle increment path in the current source.
- `openclaw.sessions.active` is declared as an up/down counter in `observability-plugin/src/telemetry.ts`, but I did not find any update calls, so it is not functionally emitted today.

## Additional composed metrics

Additional metrics can be defined composing the metrics above. For these, the plugin does not explicitly emit new signals, but one may use current metrics to build new ones. This section report some of these examples (which can be found in the Grafana dashboard provided as example)

- Agent turn counters: based on `openclaw.agent.turn_duration`, using the histogram `Count` value and grouping by `gen_ai.agent.id`.
- Memory Search Events: based on `openclaw.tool.calls`, filtering `tool.name = memory_search`.
- Memory Get Events: based on `openclaw.tool.calls`, filtering `tool.name = memory_get`.
- Memory Search Errors: based on `openclaw.tool.errors`, filtering `tool.name = memory_search`.
- Memory Edit Errors: based on `openclaw.tool.errors`, filtering `tool.name = edit`.
