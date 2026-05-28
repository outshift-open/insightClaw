# Copyright (c) 2026 Cisco Systems, Inc. and its affiliates
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
logger = logging.getLogger("db_api")

_QUERY_TYPE_ALIASES = {
    "pg_stat_activity_verbose": "pg_stat_activity",
    "stat_activity": "pg_stat_activity",
    "pool": "connection_pool",
    "blocking": "blocking_queries",
    "deployment_history": "deployments",
    "releases": "deployments",
}

_SCENARIO_CATALOG = {
    "1": {
        "name": "payment async timeout",
        "directory": "scenario1",
        "file_name": "payment-async-timeout.yaml",
    },
    "2": {
        "name": "order DB deadlock",
        "directory": "scenario2",
        "file_name": "order-db-deadlock.yaml",
    },
}


def _hash_float(service_name: str, field: str, lo: float, hi: float) -> float:
    key = f"{service_name}:{field}".encode()
    seed = int(hashlib.md5(key).hexdigest()[:8], 16) / 0xFFFFFFFF
    return lo + seed * (hi - lo)


class QueryRequest(BaseModel):
    service: str
    query_type: str = "pg_stat_activity"
    caller: str = "unknown"


class RemediateRequest(BaseModel):
    service: str
    action: str
    reason: str = "not specified"
    caller: str = "unknown"
    verifier_status: str = "unknown"


class ScenarioRequest(BaseModel):
    scenario: int = Field(..., ge=1, le=2, description="Scenario number (1 or 2)")


class SceneStore:
    def __init__(self, fixture_path: Path | None = None) -> None:
        self.fixture_path = fixture_path
        self.incident_id = "default"
        self.services: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if self.fixture_path and self.fixture_path.exists():
            with self.fixture_path.open("r", encoding="utf-8") as fh:
                raw = yaml.safe_load(fh) or {}
            self.incident_id = raw.get("id", "default")
            self.services = raw.get("services", {})
            return

        # Fallback keeps API usable even when fixture file is missing.
        self.incident_id = "fallback"
        self.services = {
            "payment_db": {
                "aliases": ["payment-db", "payment database"],
                "pg_stat_activity": {
                    "total_connections": 24,
                    "max_connections": 200,
                    "active_queries": 6,
                    "idle_connections": 18,
                    "waiting_queries": 0,
                    "blocking_queries": [],
                    "longest_running_query_seconds": 0.3,
                    "max_lock_wait_ms": 3.2,
                    "conclusion": "No blocking queries detected. Database is healthy.",
                },
                "blocking": {
                    "blocking_pids": [],
                    "blocked_pids": [],
                    "deadlocks_last_hour": 0,
                    "lock_wait_count_last_hour": 0,
                    "conclusion": "No blocking chain detected.",
                },
                "connection_pool": {
                    "pool_size": 100,
                    "active": 17,
                    "idle": 83,
                    "waiting": 0,
                    "utilisation_pct": 17.0,
                    "status": "healthy",
                    "note": "Connection pool within normal range.",
                },
            }
        }

    def _match_service(self, service_name: str) -> str | None:
        normalized = service_name.lower().replace("-", "_")
        for key, data in self.services.items():
            if normalized == key.lower().replace("-", "_"):
                return key
            for alias in data.get("aliases", []):
                if normalized == str(alias).lower().replace("-", "_"):
                    return key
        return None

    def _nominal(self, service_name: str, query_type: str) -> dict[str, Any]:
        total = int(_hash_float(service_name, "db_total_conn", 15, 45))
        active = int(_hash_float(service_name, "db_active", 3, 12))
        idle = total - active
        if query_type == "deployments":
            return {
                "deployments": [
                    {
                        "version": "1.0.0",
                        "status": "success",
                        "deployed_hours_before_incident": 24,
                        "deployed_by": "ci/cd-pipeline",
                        "commit_sha": "nominal0001",
                        "commit_message": "chore: routine deployment",
                        "duration_seconds": 75,
                        "overlap_with_incident": False,
                    }
                ],
                "incident_correlations": [],
            }
        if query_type in ("blocking_queries", "deadlocks"):
            return {
                "blocking_pids": [],
                "blocked_pids": [],
                "deadlocks_last_hour": 0,
                "lock_wait_count_last_hour": 0,
                "conclusion": "No blocking chain detected.",
            }
        if query_type == "connection_pool":
            return {
                "pool_size": 100,
                "active": active,
                "idle": 100 - active,
                "waiting": 0,
                "utilisation_pct": round(active, 1),
                "status": "healthy",
                "note": "Connection pool within normal range.",
            }
        return {
            "total_connections": total,
            "max_connections": 200,
            "active_queries": active,
            "idle_connections": idle,
            "waiting_queries": 0,
            "blocking_queries": [],
            "longest_running_query_seconds": round(
                _hash_float(service_name, "db_longest_q", 0.05, 0.4), 2
            ),
            "max_lock_wait_ms": round(
                _hash_float(service_name, "db_lock_wait", 0.5, 5.0), 1
            ),
            "conclusion": "No blocking queries detected. Database is healthy.",
        }

    def _synth_blocking(self, service: dict[str, Any]) -> dict[str, Any]:
        blocking = service.get("blocking")
        if isinstance(blocking, dict) and blocking:
            return blocking

        metrics = (
            service.get("metrics", {})
            if isinstance(service.get("metrics"), dict)
            else {}
        )
        analysis = (
            service.get("query_analysis", {})
            if isinstance(service.get("query_analysis"), dict)
            else {}
        )
        slow_queries = (
            analysis.get("slow_queries", [])
            if isinstance(analysis.get("slow_queries"), list)
            else []
        )

        deadlocks_5m = int(metrics.get("deadlock_count_last_5min", 0) or 0)
        blocking_count = int(metrics.get("blocking_queries", 0) or 0)
        lock_wait_avg_ms = metrics.get("lock_wait_avg_ms")

        if deadlocks_5m or blocking_count or slow_queries:
            return {
                "blocking_pids": [],
                "blocked_pids": [],
                "deadlocks_last_5min": deadlocks_5m,
                "blocking_query_count": blocking_count,
                "lock_wait_avg_ms": lock_wait_avg_ms,
                "suspected_query_patterns": [
                    q.get("query_pattern")
                    for q in slow_queries[:3]
                    if isinstance(q, dict)
                ],
                "conclusion": "Lock contention/deadlock pressure detected from fixture metrics and query analysis.",
            }

        return {
            "blocking_pids": [],
            "blocked_pids": [],
            "deadlocks_last_hour": 0,
            "lock_wait_count_last_hour": 0,
            "conclusion": "No blocking chain detected.",
        }

    def _synth_connection_pool(self, service: dict[str, Any]) -> dict[str, Any]:
        pool = service.get("connection_pool")
        if isinstance(pool, dict) and pool:
            return pool

        metrics = (
            service.get("metrics", {})
            if isinstance(service.get("metrics"), dict)
            else {}
        )
        pool_size = int(metrics.get("connection_pool_size", 100) or 100)
        active = int(metrics.get("active_connections", 0) or 0)
        waiting = int(metrics.get("blocking_queries", 0) or 0)
        idle = max(pool_size - active, 0)
        util = (active / pool_size) * 100 if pool_size else 0

        status = "critical" if util >= 90 else "degraded" if util >= 70 else "healthy"
        note = (
            "Connection pool saturation detected."
            if status == "critical"
            else (
                "Connection pool elevated."
                if status == "degraded"
                else "Connection pool within normal range."
            )
        )

        return {
            "pool_size": pool_size,
            "active": active,
            "idle": idle,
            "waiting": waiting,
            "utilisation_pct": round(util, 1),
            "status": status,
            "note": note,
        }

    def _synth_pg_stat_activity(self, service: dict[str, Any]) -> dict[str, Any]:
        stat = service.get("pg_stat_activity")
        if isinstance(stat, dict) and stat:
            return stat

        metrics = (
            service.get("metrics", {})
            if isinstance(service.get("metrics"), dict)
            else {}
        )
        max_connections = int(metrics.get("connection_pool_size", 200) or 200)
        active_queries = int(metrics.get("active_connections", 0) or 0)
        waiting_queries = int(metrics.get("blocking_queries", 0) or 0)
        idle_connections = max(max_connections - active_queries, 0)
        max_lock_wait_ms = float(metrics.get("lock_wait_avg_ms", 0) or 0)

        conclusion = (
            "Lock contention and pool pressure detected."
            if waiting_queries > 0 or max_lock_wait_ms > 100
            else "No blocking queries detected. Database is healthy."
        )

        return {
            "total_connections": active_queries + idle_connections,
            "max_connections": max_connections,
            "active_queries": active_queries,
            "idle_connections": idle_connections,
            "waiting_queries": waiting_queries,
            "blocking_queries": ["lock-contention"] if waiting_queries > 0 else [],
            "longest_running_query_seconds": round(max_lock_wait_ms / 1000, 2),
            "max_lock_wait_ms": round(max_lock_wait_ms, 1),
            "conclusion": conclusion,
        }

    def query(self, service_name: str, query_type: str) -> dict[str, Any]:
        if query_type not in {
            "pg_stat_activity",
            "blocking_queries",
            "deadlocks",
            "connection_pool",
            "deployments",
        }:
            raise ValueError(f"unsupported query_type: {query_type}")

        key = self._match_service(service_name)
        if key is None:
            return self._nominal(service_name, query_type)

        service = self.services[key]
        if query_type == "deployments":
            deployments = service.get("deployments", [])
            if not isinstance(deployments, list):
                deployments = []
            return {
                "deployments": deployments,
                "incident_correlations": [
                    d
                    for d in deployments
                    if isinstance(d, dict) and d.get("overlap_with_incident")
                ],
            }
        if query_type in ("blocking_queries", "deadlocks"):
            return self._synth_blocking(service)
        if query_type == "connection_pool":
            return self._synth_connection_pool(service)
        return self._synth_pg_stat_activity(service)


def _parse_scenario_arg(argv: list[str]) -> str:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument(
        "--scenario", choices=sorted(_SCENARIO_CATALOG.keys()), default="2"
    )
    args, _ = parser.parse_known_args(argv)
    return args.scenario


def _resolve_fixture_path(scenario: str = "2") -> Path | None:
    base = Path(__file__).resolve().parent / "datasets"

    scenario_info = _SCENARIO_CATALOG.get(scenario, _SCENARIO_CATALOG["2"])
    selected = base / scenario_info["directory"] / scenario_info["file_name"]
    if selected.exists():
        return selected

    env_path = os.getenv("INCIDENT_FIXTURE", "").strip()
    if env_path:
        p = Path(env_path).expanduser()
        return p if p.exists() else None

    local_default = base / "scenario2" / "order-db-deadlock.yaml"
    if local_default.exists():
        return local_default
    return None


def _list_scenarios() -> list[dict[str, Any]]:
    base = Path(__file__).resolve().parent / "datasets"
    scenarios: list[dict[str, Any]] = []

    for scenario_id in sorted(_SCENARIO_CATALOG.keys()):
        scenario_info = _SCENARIO_CATALOG[scenario_id]
        fixture_path = base / scenario_info["directory"] / scenario_info["file_name"]
        scenarios.append(
            {
                "scenario": scenario_id,
                "name": scenario_info["name"],
                "file_name": scenario_info["file_name"],
                "available": fixture_path.exists(),
                "selected": scenario_id == _SCENARIO,
            }
        )

    return scenarios


def _normalize_query_type(query_type: str | None) -> str:
    if not query_type:
        return "pg_stat_activity"
    return _QUERY_TYPE_ALIASES.get(query_type, query_type)


async def _parse_query_request(req: Request) -> QueryRequest:
    payload: dict[str, Any] = dict(req.query_params)
    body_text = ""

    try:
        body = await req.json()
    except Exception:
        body = None

    if isinstance(body, dict):
        payload.update(body)
        arguments = body.get("arguments")
        if isinstance(arguments, dict):
            payload.update(arguments)
    else:
        raw = await req.body()
        if raw:
            body_text = raw.decode("utf-8", errors="ignore").strip()
            if body_text:
                try:
                    parsed = json.loads(body_text)
                except Exception:
                    parsed = None
                if isinstance(parsed, dict):
                    payload.update(parsed)

    service = payload.get("service") or payload.get("service_name")
    if not service and len(store.services) == 1:
        service = next(iter(store.services.keys()))

    query_type = _normalize_query_type(
        payload.get("query_type") or payload.get("query")
    )
    caller = payload.get("caller") or req.headers.get("X-Agent-Id") or "unknown"

    if not service:
        raise HTTPException(
            status_code=400,
            detail="missing service; provide 'service' or 'service_name'",
        )

    return QueryRequest(service=service, query_type=query_type, caller=caller)


_SCENARIO = _parse_scenario_arg(sys.argv[1:])
_FIXTURE_PATH = _resolve_fixture_path(_SCENARIO)
store = SceneStore(_FIXTURE_PATH)


def _set_scenario(scenario: int) -> dict[str, Any]:
    """Dynamically reload the scenario fixture.

    Args:
        scenario: Scenario number (1 or 2)

    Returns:
        Dictionary with status and loaded scenario info
    """
    global _SCENARIO, _FIXTURE_PATH, store

    scenario_str = str(scenario)
    if scenario_str not in _SCENARIO_CATALOG:
        raise ValueError(
            f"Invalid scenario: {scenario_str}. Must be one of {', '.join(sorted(_SCENARIO_CATALOG.keys()))}."
        )

    previous_scenario = _SCENARIO
    previous_fixture = _FIXTURE_PATH.name if _FIXTURE_PATH else None

    _SCENARIO = scenario_str
    _FIXTURE_PATH = _resolve_fixture_path(_SCENARIO)
    store = SceneStore(_FIXTURE_PATH)
    current_fixture = _FIXTURE_PATH.name if _FIXTURE_PATH else None

    logger.info(
        "Scenario reloaded: %s (%s) -> %s (%s), file: %s -> %s, incident_id=%s services=%s",
        previous_scenario,
        previous_fixture,
        _SCENARIO,
        current_fixture,
        previous_fixture,
        current_fixture,
        store.incident_id,
        sorted(store.services.keys()),
    )

    return {
        "status": "ok",
        "scenario": _SCENARIO,
        "file_name": _FIXTURE_PATH.name if _FIXTURE_PATH else None,
        "incident_id": store.incident_id,
        "loaded_services": sorted(store.services.keys()),
        "timestamp": datetime.utcnow().isoformat() + "Z",
    }


app = FastAPI(title="OpenClaw DB API", version="1.0.0")


@app.get("/health")
def health(req: Request) -> dict[str, Any]:
    caller = req.headers.get("X-Agent-Id", "unknown")
    logger.info("caller=%s endpoint=GET /health", caller)
    return {
        "status": "ok",
        "incident_id": store.incident_id,
        "loaded_services": sorted(store.services.keys()),
        "timestamp": datetime.utcnow().isoformat() + "Z",
    }


@app.get("/services")
def services(req: Request) -> dict[str, Any]:
    caller = req.headers.get("X-Agent-Id", "unknown")
    logger.info("caller=%s endpoint=GET /services", caller)
    return {"services": sorted(store.services.keys())}


@app.get("/scenario")
def get_scenario(req: Request) -> dict[str, Any]:
    caller = req.headers.get("X-Agent-Id", "unknown")
    logger.info("caller=%s endpoint=GET /scenario", caller)
    return {
        "scenario": _SCENARIO,
        "file_name": _FIXTURE_PATH.name if _FIXTURE_PATH else None,
        "incident_id": store.incident_id,
        "loaded_services": sorted(store.services.keys()),
    }


@app.get("/scenarios")
def list_scenarios(req: Request) -> dict[str, Any]:
    caller = req.headers.get("X-Agent-Id", "unknown")
    logger.info("caller=%s endpoint=GET /scenarios", caller)
    return {
        "selected": _SCENARIO,
        "scenarios": _list_scenarios(),
    }


@app.post("/scenario")
def set_scenario(request: ScenarioRequest, req: Request) -> dict[str, Any]:
    caller = req.headers.get("X-Agent-Id", "unknown")
    logger.info(
        "caller=%s endpoint=POST /scenario scenario=%s", caller, request.scenario
    )
    try:
        result = _set_scenario(request.scenario)
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/query_db")
async def query_db(req: Request) -> dict[str, Any]:
    request = await _parse_query_request(req)
    logger.info(
        "caller=%s endpoint=POST /query_db service=%s query_type=%s",
        request.caller,
        request.service,
        request.query_type,
    )
    try:
        data = store.query(request.service, request.query_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "service": request.service,
        "query_type": request.query_type,
        "data": data,
    }


@app.post("/remediate")
def remediate(request: RemediateRequest) -> dict[str, Any]:
    logger.info(
        "caller=%s endpoint=POST /remediate service=%s action=%s verifier_status=%s",
        request.caller,
        request.service,
        request.action,
        request.verifier_status,
    )
    remediation_id = f"rmd-{int(datetime.utcnow().timestamp())}"
    return {
        "status": "accepted",
        "remediation_id": remediation_id,
        "service": request.service,
        "action": request.action,
        "reason": request.reason,
        "verifier_status": request.verifier_status,
        "message": "Fake remediation API accepted the request.",
        "timestamp": datetime.utcnow().isoformat() + "Z",
    }


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description="OpenClaw DB API")
    cli.add_argument("--scenario", choices=["1", "2"], default="2")
    cli.add_argument("--host", default="127.0.0.1")
    cli.add_argument("--port", type=int, default=8765)
    args = cli.parse_args()

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)
