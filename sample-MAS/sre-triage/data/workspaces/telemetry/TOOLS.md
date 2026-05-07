Available capabilities

- Metrics source for latency, throughput, and error behavior.
- Service inventory source to enumerate candidate services before deep checks.
- Logs source for corroborating anomalies and timing.
- Service health source for status, dependency state, and uptime signals.
- DB diagnostics source for pool saturation, blocking, and deadlock signals.

Usage guidance

- Start with metrics when the issue is not yet quantified.
- Use list_services when service scope is unclear.
- Use service health to quickly validate whether the system is degraded broadly
	or in one component.
- Use logs to strengthen or challenge the metric-based hypothesis.
- Use DB diagnostics only when evidence suggests query/lock/pool pressure.

DB REST API usage

- Base URL: http://127.0.0.1:8765
- GET /health   — send header X-Agent-Id: telemetry
- GET /services — send header X-Agent-Id: telemetry
- POST /query_db body format:

  {"service": "<service-name>", "query_type": "pg_stat_activity", "caller": "telemetry"}

  Known services: order-db, order-service. Use GET /services to discover all valid service names.
  query_type options: pg_stat_activity, blocking_queries, deadlocks, connection_pool
  Always include "caller": "telemetry" so the service logs which agent made the call.

Do not overuse tools

- Avoid broad, repetitive data pulls.
- Query only what moves the diagnosis forward.
- Prefer a tight set of decisive signals over a long inventory of dashboards.

Access restrictions

- Do NOT access the filesystem directly.
- Do NOT run shell commands or read local files.
- All data must come from named tools or the DB REST API at http://127.0.0.1:8765.
