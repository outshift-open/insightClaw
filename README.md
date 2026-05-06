# OpenClaw Deep Observability

OpenClaw Deep Observability adds OpenTelemetry-based tracing and metrics to
OpenClaw with a focus on end-to-end request visibility for multi-agent workflows.

The main deliverable in this repository is a custom OpenClaw observability plugin that captures:

- connected request, agent, tool, and outbound-message traces
- LLM usage, model, token, and cost enrichment
- gateway diagnostics such as queue, webhook, session, and tool-loop signals
- optional provider SDK auto-instrumentation for Anthropic, OpenAI, Bedrock, and Vertex AI

## Repository Contents

- `observability-plugin/`: the plugin, preload instrumentation, tests, and local deploy assets
- `docs/`: solution brief, dashboard/runbook material, and the OTel GenAI transition plan
- `sample-MAS/`: SRE triage MAS application and workspace material

## Quick Start

1. Start the local observability stack:

   ```bash
   cd observability-plugin/deploy
   docker-compose up -d
   ```

2. Install plugin dependencies:

   ```bash
   cd ../ # from observability-plugin/deploy to observability-plugin/
   npm install
   ```

3. Add the plugin to your OpenClaw config:

   ```json
   {
     "plugins": {
       "load": {
         "paths": ["/absolute/path/to/openclaw-deep-observability/observability-plugin"]
       },
       "entries": {
         "openclaw-deep-observability": {
           "enabled": true,
           "config": {
             "endpoint": "http://host.docker.internal:4318",
             "serviceName": "openclaw-gateway",
             "protocol": "http",
             "traces": true,
             "metrics": true,
             "captureContent": false
           }
         }
       }
     }
   }
   ```

4. Restart OpenClaw:

   ```bash
   openclaw gateway restart
   ```

## Documentation

- Plugin setup and overview: [observability-plugin/OVERVIEW.md](observability-plugin/OVERVIEW.md)
- Plugin metrics: [docs/METRICS.md](docs/METRICS.md)

## Development

From `observability-plugin/`:

```bash
npm install
npm test
npm run typecheck
npm run build
```

For provider SDK auto-instrumentation, see the preload instructions in
[observability-plugin/README.md](observability-plugin/README.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
