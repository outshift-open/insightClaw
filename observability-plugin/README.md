# InsightClaw Plugin

## Custom Hook-Based Plugin

For **deeper observability**, install the custom plugin from this repository.
It uses OpenClaw's typed plugin hooks to capture the full agent lifecycle.

### What It Adds

**Connected Traces:**

```text
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

**Session Semantics:**

- `session.start` and `session.end` represent the plugin's user workflow session lifecycle
- A session ends after 5 minutes of inactivity by default
- OpenClaw `sessionKey` and `conversationId` are treated as runtime-session correlation identifiers and exported as `openclaw.runtime.session.*`
- Optional `spanCache` retains a rolling in-process window of span attributes for trace/session lookups and derived metrics
- Optional `spanCacheVerboseLogs` promotes span-cache insert/lookup/flush logs to the normal OpenClaw info log stream

**Agent Payload Visibility:**

- Optional payload capture on `openclaw.agent.turn`, `openclaw.request`, `openclaw.llm.call`, `tool.<name>`, and `openclaw.message.sent` when `captureContent=true`
- OTel GenAI semconv payload fields: `gen_ai.input.messages` / `gen_ai.output.messages` on request, agent, and LLM spans; `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` on tool spans
- Set `emitIoaObserveAttributes: false` to suppress `ioa_observe.*` IOA-specific attributes (fork/join topology, handoff sequence, entity payloads) and emit only OTel GenAI semconv fields

**Request Lifecycle:**

- Full message → response tracing
- Session context propagation
- Outbound delivery visibility via `message_sent`, diagnostic `message.processed`,
or webchat `agent_end` inference when no outbound signal exists
- Agent turn duration with token breakdown
- Fallback `openclaw.request` root span creation during `before_model_resolve`
or `before_prompt_build`, with `before_agent_start` retained for legacy runtimes
when inbound hooks only expose conversation metadata

### Installation

1. Clone this repository:

   ```bash
   git clone https://github.com/outshift-open/insightClaw.git
   ```

2. Navigate to the `deploy` directory and start the observability stack, which includes a ClickHouse instance and
an OpenTelemetry Collector configured to receive OTel data and forward it to ClickHouse:

   ```bash
   cd insightClaw/observability-plugin/deploy
   docker-compose up -d
   ```

3. Add to your `openclaw.json`, usually under `~/.openclaw/` folder. The `paths` entry should point to the location of the plugin on your machine.
The endpoint should point to your OpenTelemetry Collector's OTLP HTTP receiver
(default `http://host.docker.internal:4318` when using the provided Docker setup on Mac/Windows
or `http://172.17.0.1:4318` when using Docker on Linux):

   ```json
   {
     "plugins": {
       "load": {
         "paths": ["/path/to/insightClaw/observability-plugin"]
       },
       "entries": {
         "insightclaw": {
           "enabled": true,
           "config": {
             "endpoint": "http://host.docker.internal:4318",
             "serviceName": "openclaw-gateway",
             "protocol": "http",
              "traces": true,
              "metrics": true,
              "captureContent": true,
              "spanCache": false,
                "spanCacheVerboseLogs": false,               "emitIoaObserveAttributes": true,                "customAttributes": {
                  "workspace-id": "UUID1",
                  "mas-id": "UUID2"
                }
           }
         }
       }
     }
   }
   ```

4. Build the plugin and install dependencies:

   ```bash
   cd insightClaw/observability-plugin
   npm install
   ```

5. Restart the openclaw gateway:

   ```bash
   openclaw gateway restart
   ```

  `customAttributes` is copied onto each `openclaw.request` root span only.
  The attributes are exported with the trace to the OTel collector and downstream sink without being repeated on every child span.

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
   export NODE_OPTIONS="--import /absolute/path/to/repo/observability-plugin/instrumentation/preload.mjs"

   openclaw gateway start
   ```

This can be also put inside the openclaw gateway service description, to avoid having to re-export the variables each time.
To do so:

```bash
mkdir -p ~/.config/systemd/user/openclaw-gateway.service.d
cat << EOF > ~/.config/systemd/user/openclaw-gateway.service.d/override.conf
[Service]
Environment=OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
Environment=OTEL_SERVICE_NAME=openclaw-gateway
Environment=NODE_OPTIONS="--import /path/to/instrumentation/preload.mjs"
EOF
systemctl --user daemon-reload
```

Make sure that the path is the absolute path to the preload.mjs file.

In addition to that, there is a small patch that can be applied to fix a known issue in openllmetry.
See in the caveats section for more information.

### Supported Provider SDKs

- Anthropic
- OpenAI
- Amazon Bedrock
- Google Vertex AI

1. Verify startup logs:

  ```text
  [insightClaw] GenAI instrumentation active (providers=anthropic,bedrock,openai,vertexai, ...)
  [insightClaw] ✅ GenAI instrumentation active via NODE_OPTIONS preload
  ```

### Preload the instrumentation

The plugin itself runs in a different module-loading context from the provider SDKs.
Patching provider SDKs from inside the plugin is too late and does not affect the
ESM module instances OpenClaw is already using.

Using `NODE_OPTIONS=--import .../preload.mjs` fixes that by registering the ESM loader
hook before the SDKs are imported.

### Telemetry visualisation

By default, the otel-collector deployment includes a clickhouse DB server,
and the otel-collector is configured to push telemetry data directly into it.
Data can be seen from a terminal there by using the `clickhouse-client` tool.
However, we also provide a more complete deployment, with a preconfigured grafana dashboard.
To use it, simply deploy the complete docker compose file:

```bash
cd insightClaw/observability-plugin/deploy
docker-compose up -f docker-compose-with-grafana.yaml -d
```

Grafana is then available at `http://localhost:3000` (user/password: admin/admin).
It is already configured to use the clickhouse DB as the default datasource.
The dashboard `OpenClaw Metrics dashboard` is loaded as well, and configured to use the clickhouse DB datasource,
no additional configuration is needed on your side.

### Caveats

#### LiteLLM provider

For LLM providers that uses the `openai-completions`, the reported token usage is always 0,
as stated in this [issue](https://github.com/openclaw/openclaw/issues/56670).
By default, OpenClaw disables the report of usage tokens via the stream options,
since there is no guarantee that the selected model would support it.
This can be specified per model, by adding the following attribute to the model description in the LLM provider:

```json
"compat" : {
  "supportsUsageInStreaming": true
}
```

For example, when using liteLLM:

```json
"providers": {
  "litellm": {
    "baseUrl": "https://llm-proxy.prod.outshift.ai",
    "api": "openai-completions",
    "models": [
      {
        "id": "MODEL_ID",
        "name": "MODEL_NAME",
        "api": "openai-completions",
        "reasoning": true,
        "input": [
          "text",
          "image"
        ],
        "contextWindow": 128000,
        "maxTokens": 8192,
        "compat": {
          "supportsUsageInStreaming": true
        }
      },
    ]
  }
}
```

#### OpenLLMetry instrumentation

By default, OpenClaw is using streaming mode from LLM providers, and the token report from the provider is not taken
into account by openLLMetry auto-instrumentation.
A [PR](https://github.com/traceloop/openllmetry-js/pull/941) is addressing this issue.
Till this PR is merged, the best we can have (without installing openllmetry from source) is to enable the current
approach of openLLMetry, that is, relying on estimating the tokens usage via tiktoken.
This is done by setting this env variable `TRACELOOP_ENRICH_TOKENS=true`.

We provide a small patch to apply the content of the PR directly in the code. To enable it:
once you have built the plugin (`npm install`), you can apply the patch (from the `observability-plugin/` folder):

```bash
cp openllmetry-patch-index.js node_modules/@traceloop/instrumentation-openai/dist/index.js
```

---
