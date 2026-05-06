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
| Context Assembly Latency | Histogram | Time to collect, filter, prioritize, and assemble context | Based on context preparation span |
| Downstream Context Disclosure Ratio | Histogram | % of parent context passed to sub‑agents | Based on heuristics to approximate context-reuse |
| Context Sharing | Histogram | How many agent turns reuse identical or near‑identical context | Based on heuristics to approximate content-reuse |

### Memory Lifecycle

| Metric | Type | Description | Notes |
| :-- | :-- | :-- | :-- |
| Memory Fragmentation Score (openclaw.memory.search_fragmentation) | Histogram | Dispersion of relevant memory across files/items | Supported |

### Routing and Delegation

| Metric | Type | Description | Notes |
| :-- | :-- | :-- | :-- |
| Parallelisation Score | Histogram | Ratio processing time of all the agents and the session duration |  |

Additional derived metrics could be available, but they require more investigation.