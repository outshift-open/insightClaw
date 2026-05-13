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

## Derived Metrics

### Context assembly

| Metric | Type | When emitted | Description | 
| :-- | :-- | :-- | :-- | 
| openclaw.context.system_size | Histogram | On llm_input |#bytes in the agent context generated by system prompt (SOUL.md, Agent.md etc.)
| openclaw.context.prompt_size | Histogram | On llm_input| #bytes in the agent context generated by the prompt size
| openclaw.context.history_memory_size | Histogram | On llm_input| #bytes in the agent context generated by memory-tool output in the history
| openclaw.context.history_tool_size | Histogram | On llm_input| #bytes in the agent context generated by tool-output in the history (no memory tools)
| openclaw.context.history_user_size | Histogram | On llm_input| #bytes in the agent context generated by user-interaction (from history)
| openclaw.context.history_other_size | Histogram | On llm_input| #bytes in the agent context generated by anything else in the history
| openclaw.context.preparation_duration | Histogram | On llm_input| time between llm_input hook and before_agent_start . It indicates the time needed to prepare the context |
| openclaw.agent.downstream_context_sharing| Histogram | On llm_input| Estimates how much of the caller agent full context (prompt, history, system…) is covered by the sub-agent prompt (based on n-grams text analysis and some heuristics). High score means the caller shares a lot of its context with the sub-agent. [Experimental]
| openclaw.agent.novelty_score | Histogram | on llm_output and agent_end| Estimates how much of the sub-agent reply is novel, comparing it to the caller-agent full context (prompt, history, system...). Based on text heuristic and n-grams text analysis, highly experimental. Low score means the majority of text in the sub-agent output can be found already in the main-agent context i.e. in its history. (available also using embeddings instead of n-grams processing, BUT it slows down the processing, especially comparing replies with large context. The embedding-based metric requires some optimisation) [Experimental]


### Memory Lifecycle

| Metric | Type | When emitted | Description |
| :-- | :-- | :-- | :-- |
| openclaw.memory.search_fragmentation | Histogram | On (memory) tool_result_persist and after_tool_call | it measures how much the information is spread across different long-term memory files. Computed when using the memory_search tool to access the long term memory, as the ratio of the unique files in the results and the number of hits returned by the tool (i.e. 1 unique file in n hits means fragmentation is 0, 10 unique files in 10 hits means fragmentation is 0.9)

### Routing and Delegation

| Metric | Type | When emitted  | Description |
| :-- | :-- | :-- | :-- |
| openclaw.session.parallelisation_score | Histogram | On end of session |it’s an indicator of the efficiency of the session (how much tasks were parallelised, how much agents waited idle). Computed as the ratio between the total durations of  all the spans of type agent-turn, and the total session duration. The higher the score, the more parallelization there was in the session (i.e., multiple agents working at the same time, or an agent working while waiting for a tool response). Low score means low parallelisation or the agent waiting for external actions. A score close to 1 means the session was quite sequential and with not much idle time. A score largely below 1 means agents were idle for a significant amout of time.
| openclaw.session.repetition_score | Histogram | On end of session | Indicates how much agents re-issue the “same” request to the same agent (i.e. because the first request failed, or the answer was not satisfying). Given all the LLM calls (openclaw.llm.call) in a session (including sub-agents and other top-level agents), it computes a per-agent Jaccard similarity between the different input prompts of that agent, and then reports the average across. High score means that there are agents that got called several time with the "same" input in the session. (Available also using embeddings instead of Jaccard).


Note: metrics flagged as [Experimental] are still at an early stage and not production-level. By default they are disabled in the plugin (must be enabled via `experimentalMetrics` configuration).

## Additional composed metrics
Additional metrics can be defined composing the metrics above. For these, the plugin does not explicitly emit new signals, but one may use current metrics to build new ones. This section report some of these examples (which can be found in the Grafana dashboard provided as example)

- Agent turn counters: based on `openclaw.agent.turn_duration` histogram, using `Count` value and grouping by agent ID (`gen_ai.agent.id`)
- Memory Search Events: based on `openclaw.tool.calls`, filtering `tool_name = memory_search`
- Memory Get Events: based on `openclaw.tool.calls`, filtering `tool_name = memory_get`
- Memory Search Errors: based on `openclaw.tool.errors`, filtering `tool_name = memory_search`
- Memory Edit Errors: based on `openclaw.tool.errors`, filtering `tool_name = memory_search`