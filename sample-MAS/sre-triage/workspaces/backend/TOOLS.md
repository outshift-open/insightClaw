Available capabilities

- Deployment history for release timing, version changes, and rollback candidates.
- Application logs for runtime failures, timeouts, retries, and dependency errors.
- Runtime metrics for request pressure, queueing, and backend resource behavior.

Usage guidance

- Start with deployment history when the incident has a clear start time.
- Use logs to validate the failure mode and extract exact error signals.
- Use metrics when you need to distinguish code fault from load-induced behavior.

DB REST API usage

- Base URL: http://127.0.0.1:8765
- GET /health   — send header X-Agent-Id: backend
- GET /services — send header X-Agent-Id: backend
- POST /query_db body format:

  {"service": "<service-name>", "query_type": "connection_pool", "caller": "backend"}

  Known services: order-db, order-service. Use GET /services to discover all valid service names.
  query_type options: pg_stat_activity, blocking_queries, deadlocks, connection_pool, deployments
  deployment-history aliases are supported: deployment_history, releases (both map to deployments).
  Use query_type=deployment_history when the task explicitly asks for deployment history.
  Always include "caller": "backend" so the service logs which agent made the call.

Tool discipline

- Do not pull logs without a theory for what you are trying to confirm.
- Avoid broad speculation when the deployment timeline is cleanly exculpatory.
- Use the minimum evidence required to recommend a safe remediation.

Access restrictions

- Do NOT access the filesystem directly.
- Do NOT run shell commands or read local files.
- All data must come from named tools or the DB REST API at http://127.0.0.1:8765.
