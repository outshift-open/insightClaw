# InsightClaw

InsightClaw adds OpenTelemetry-based tracing and metrics to
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
         "paths": ["/absolute/path/to/insightClaw/observability-plugin"]
       },
       "entries": {
         "insightClaw": {
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

## Usage with DefenseClaw

DefenseClaw is a governance plugin that enforces policies on agent behaviour. InsightClaw complements it with its observability features.
When both plugins are loaded together, InsightClaw's hook-wrapping mechanism automatically traces DefenseClaw's handler executions,
surfacing which tools were blocked, and what decisions were made; all within the same trace.

To install DefenseClaw, follow the instructions on their [repository](https://github.com/cisco-ai-defense/defenseclaw).

## Documentation

- Plugin setup and overview: [docs/OVERVIEW.md](docs/OVERVIEW.md)
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

## License

Apache 2.0. See [LICENSE](LICENSE).

## Security

If you discover a security vulnerability, please do not open a public issue.
Contact the maintainers directly via the repository security advisory process.
