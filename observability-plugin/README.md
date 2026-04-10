# OpenClaw Observe PoC


## Initial Approach: Custom Hook-Based Plugin

For **deeper observability**, install the custom plugin from this repo. It uses OpenClaw's typed plugin hooks to capture the full agent lifecycle.

### What It Adds

**Connected Traces:**
```
openclaw.request (root span)
├── openclaw.agent.turn
│   ├── llm.claude-sonnet-4
│   ├── tool.Read (file read)
│   ├── tool.exec (shell command)  
│   ├── tool.Write (file write)
│   └── tool.web_search
└── openclaw.message.sent
```

**Per-Tool Visibility:**
- Individual spans for each tool call
- Explicit tool start/end lifecycle hooks when OpenClaw exposes them
- Tool execution time and result size
- Optional tool input/output payload capture on tool spans
- Error tracking per tool

**Per-LLM Visibility:**
- Explicit `llm_input` and `llm_output` spans when available
- Token usage and model/provider attributes on both LLM and agent spans
- Fallback token extraction from `agent_end` messages when diagnostics are unavailable
- Diagnostic `model.usage` spans plus cost/context metrics from OpenClaw diagnostics

**Gateway Diagnostics:**
- Webhook, queue, message, session, and tool-loop diagnostics recorded as OTel metrics/spans
- Session state and stuck-session signals available alongside connected request traces

**Agent Payload Visibility:**
- Optional agent input/output payload capture on `openclaw.agent.turn`
- Request input captured on the root request span
- Outbound message payload captured on `openclaw.message.sent`

**Request Lifecycle:**
- Full message → response tracing
- Session context propagation
- Outbound `message_sent` tracing for delivery visibility
- Agent turn duration with token breakdown
- Fallback `openclaw.request` root span creation during `before_agent_start` when inbound hooks only expose conversation metadata

### Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/91pavan/openclaw-observe-poc.git
   ```

2. Add to your `openclaw.json`:
   ```json
   {
     "plugins": {
       "load": {
         "paths": ["/path/to/openclaw-observe-poc"]
       },
       "entries": {
         "otel-observe-poc": {
           "enabled": true,
           "config": {
             "endpoint": "http://localhost:4318",
             "serviceName": "openclaw-gateway"
           }
         }
       }
     }
   }
   ```

3. Restart gateway:
   ```bash
   openclaw gateway restart
   ```

### Enable GenAI SDK Auto-Instrumentation

The plugin's hook-based spans work on their own, but provider SDK auto-instrumentation
for Anthropic, OpenAI, Bedrock, and Vertex AI is enabled through the preload entrypoint in
`instrumentation/preload.mjs`.

This preload runs before OpenClaw imports the provider SDKs, which is required for
`import-in-the-middle` to patch the modules correctly.

1. Install dependencies:
  ```bash
  npm install
  ```

2. Start OpenClaw with the preload enabled:
  ```bash
  export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
  export OTEL_SERVICE_NAME=openclaw-gateway
  export NODE_OPTIONS="--import ./instrumentation/preload.mjs"

  openclaw gateway start
  ```

### Supported Provider SDKs

- Anthropic
- OpenAI
- Amazon Bedrock
- Google Vertex AI

1. Verify startup logs:
  ```text
  [otel-preload] GenAI instrumentation active (providers=anthropic,bedrock,openai,vertexai, ...)
  [otel] ✅ GenAI instrumentation active via NODE_OPTIONS preload
  ```

### Preload the instrumentation

The plugin itself runs in a different module-loading context from the provider SDKs.
Patching provider SDKs from inside the plugin is too late and does not affect the
ESM module instances OpenClaw is already using.

Using `NODE_OPTIONS=--import .../preload.mjs` fixes that by registering the ESM loader
hook before the SDKs are imported.

---

## Comparing the Two Approaches

| Feature | Official Plugin | Custom Plugin |
|---------|-----------------|---------------|
| Token metrics | ✅ Per model | ✅ Per session + model |
| Cost tracking | ✅ Yes | ✅ Yes (from diagnostics) |
| Gateway health | ✅ Webhooks, queues, sessions | ✅ Via diagnostics listener |
| Session state | ✅ State transitions | ✅ Via diagnostics listener |
| **Tool call tracing** | ❌ No | ✅ Individual tool spans |
| **Request lifecycle** | ❌ No | ✅ Full request → response |
| **Connected traces** | ❌ Separate spans | ✅ Parent-child hierarchy |
| Setup complexity | 🟢 Config only | 🟡 Plugin installation |

---

## Configuration Reference

### Official Plugin Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `diagnostics.enabled` | boolean | false | Enable diagnostics system |
| `diagnostics.otel.enabled` | boolean | false | Enable OTel export |
| `diagnostics.otel.endpoint` | string | — | OTLP endpoint URL |
| `diagnostics.otel.protocol` | string | "http/protobuf" | Protocol |
| `diagnostics.otel.headers` | object | — | Custom headers |
| `diagnostics.otel.serviceName` | string | "openclaw" | Service name |
| `diagnostics.otel.traces` | boolean | true | Enable traces |
| `diagnostics.otel.metrics` | boolean | true | Enable metrics |
| `diagnostics.otel.logs` | boolean | false | Enable logs |
| `diagnostics.otel.sampleRate` | number | 1.0 | Trace sampling (0-1) |

### Custom Plugin Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | string | — | OTLP endpoint URL |
| `serviceName` | string | "openclaw-gateway" | Service name |
| `exporterType` | string | "otlp" | Exporter type |
| `enableTraces` | boolean | true | Enable traces |
| `enableMetrics` | boolean | true | Enable metrics |
| `captureContent` | boolean | false | Capture request, agent, tool, and response payload content in spans |

---


