#!/usr/bin/env bash
set -euo pipefail

REMOTE="${1:-manang@192.168.1.55}"
REMOTE_USER="${REMOTE%@*}"
if [ "${REMOTE_USER}" = "${REMOTE}" ]; then
	REMOTE_HOME="/home/${REMOTE_USER}"
else
	REMOTE_HOME="/home/${REMOTE_USER}"
fi
if [ "${REMOTE_USER}" = "root" ]; then
	REMOTE_HOME="/root"
fi
REMOTE_BASE="${REMOTE_HOME}/.openclaw"
REMOTE_WS="${REMOTE_BASE}/workspaces"
REMOTE_SERVICES="${REMOTE_BASE}/services"
REMOTE_SCRIPTS_DIR="${REMOTE_BASE}/scripts"
OPENCLAW_JSON="${REMOTE_BASE}/openclaw.json"
DB_SCENARIO="${DB_SCENARIO:-2}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRE_TRIAGE_DIR="${SCRIPT_DIR}/data"

echo "[1/6] Copy workspace definitions"
ssh "${REMOTE}" "mkdir -p ${REMOTE_WS}/{sre,telemetry,backend,db,verifier,comms}"
scp -r "${SRE_TRIAGE_DIR}/workspaces/sre" "${REMOTE}:${REMOTE_WS}/"
scp -r "${SRE_TRIAGE_DIR}/workspaces/telemetry" "${REMOTE}:${REMOTE_WS}/"
scp -r "${SRE_TRIAGE_DIR}/workspaces/backend" "${REMOTE}:${REMOTE_WS}/"
scp -r "${SRE_TRIAGE_DIR}/workspaces/db" "${REMOTE}:${REMOTE_WS}/"
scp -r "${SRE_TRIAGE_DIR}/workspaces/verifier" "${REMOTE}:${REMOTE_WS}/"
scp -r "${SRE_TRIAGE_DIR}/workspaces/comms" "${REMOTE}:${REMOTE_WS}/"

echo "[2/6] Copy DB API package"
ssh "${REMOTE}" "mkdir -p ${REMOTE_SERVICES}/db_api"
scp -r "${SRE_TRIAGE_DIR}/services/db_api/"* "${REMOTE}:${REMOTE_SERVICES}/db_api/"

scp -r "${SRE_TRIAGE_DIR}/scripts/" "${REMOTE}:${REMOTE_SCRIPTS_DIR}"

echo "[3/6] Ensure agent runtime dirs and seed configs"
printf '%s
' \
'import json' \
'from pathlib import Path' \
"base = Path('${REMOTE_BASE}')" \
'agents_base = base / "agents"' \
'template = agents_base / "main" / "agent"' \
'template_models = template / "models.json"' \
'template_auth = template / "auth-profiles.json"' \
'agent_ids = ["sre", "telemetry", "backend", "db", "verifier", "comms"]' \
'for aid in agent_ids:' \
'    adir = agents_base / aid / "agent"' \
'    sdir = agents_base / aid / "sessions"' \
'    adir.mkdir(parents=True, exist_ok=True)' \
'    sdir.mkdir(parents=True, exist_ok=True)' \
'    if not template.exists():' \
'        print(f"Warning: template agent directory {template} does not exist.")' \
'    if template_models.exists() and not (adir / "models.json").exists():' \
'        (adir / "models.json").write_text(template_models.read_text(encoding="utf-8"), encoding="utf-8")' \
'    if template_auth.exists() and not (adir / "auth-profiles.json").exists():' \
'        (adir / "auth-profiles.json").write_text(template_auth.read_text(encoding="utf-8"), encoding="utf-8")' \
'    sessions = sdir / "sessions.json"' \
'    if not sessions.exists():' \
'        sessions.write_text(json.dumps({"version": 1, "sessions": []}, indent=2) + "\\n", encoding="utf-8")' \
| ssh "${REMOTE}" "python3"

echo "[4/6] Register agents in openclaw.json"
printf '%s
' \
'import json' \
'import re' \
'from pathlib import Path' \
'from datetime import datetime, timezone' \
"config_path = Path('${OPENCLAW_JSON}')" \
'raw = config_path.read_text(encoding="utf-8")' \
'decoder = json.JSONDecoder()' \
'def _decode_strict(text):' \
'    s = text.lstrip()' \
'    obj, end = decoder.raw_decode(s)' \
'    trailing = s[end:]' \
'    if trailing.strip():' \
'        raise ValueError("Trailing non-whitespace content detected after JSON object")' \
'    return obj' \
'def parse_loose(text):' \
'    try:' \
'        return _decode_strict(text)' \
'    except Exception:' \
'        cleaned = []' \
'        for line in text.splitlines():' \
'            t = line.lstrip()' \
'            if t.startswith("#") or t.startswith("//"):' \
'                continue' \
'            cleaned.append(line)' \
'        sanitized = "\n".join(cleaned)' \
'        # Accept JSONC-style trailing commas before object/array close.' \
'        while True:' \
'            newer = re.sub(r",(\\s*[}\\]])", r"\\1", sanitized)' \
'            if newer == sanitized:' \
'                break' \
'            sanitized = newer' \
'        return _decode_strict(sanitized)' \
'cfg = parse_loose(raw)' \
'cfg.setdefault("agents", {})' \
'cfg["agents"].setdefault("list", [])' \
'agent_list = cfg["agents"]["list"]' \
'new_agents = [' \
'  {"id": "sre", "name": "SRE Lead", "workspace": "'"${REMOTE_WS}"'/sre", "agentDir": "'"${REMOTE_BASE}"'/agents/sre", "identity": {"name": "SRE Lead"}, "subagents": {"allowAgents": ["telemetry", "backend", "db"]}, "tools": {"allow": ["sessions_spawn", "sessions_list", "sessions_send"]}},' \
'  {"id": "telemetry", "name": "Telemetry Analyst", "workspace": "'"${REMOTE_WS}"'/telemetry", "agentDir": "'"${REMOTE_BASE}"'/agents/telemetry", "identity": {"name": "Telemetry"}, "tools": {"allow": ["exec"]}},' \
'  {"id": "backend", "name": "Backend Specialist", "workspace": "'"${REMOTE_WS}"'/backend", "agentDir": "'"${REMOTE_BASE}"'/agents/backend", "identity": {"name": "Backend"}, "tools": {"allow": ["exec"]}},' \
'  {"id": "db", "name": "Database Specialist", "workspace": "'"${REMOTE_WS}"'/db", "agentDir": "'"${REMOTE_BASE}"'/agents/db", "identity": {"name": "Database"}, "tools": {"allow": ["exec"]}},' \
'  {"id": "verifier", "name": "Verifier", "workspace": "'"${REMOTE_WS}"'/verifier", "agentDir": "'"${REMOTE_BASE}"'/agents/verifier", "identity": {"name": "Verifier"}},' \
'  {"id": "comms", "name": "Communications", "workspace": "'"${REMOTE_WS}"'/comms", "agentDir": "'"${REMOTE_BASE}"'/agents/comms", "identity": {"name": "Communications"}}' \
']' \
'existing = {a.get("id"): i for i, a in enumerate(agent_list) if isinstance(a, dict)}' \
'for agent in new_agents:' \
'    aid = agent["id"]' \
'    if aid in existing:' \
'        agent_list[existing[aid]].update(agent)' \
'    else:' \
'        agent_list.append(agent)' \
'agent_list[:] = [a for a in agent_list if not (isinstance(a, dict) and a.get("id") in set())]' \
'ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")' \
'backup = config_path.with_name("openclaw.json.bak.install." + ts)' \
'backup.write_text(raw, encoding="utf-8")' \
'candidate = json.dumps(cfg, indent=2) + "\\n"' \
'json.loads(candidate)' \
'tmp = config_path.with_name("openclaw.json.tmp." + ts)' \
'tmp.write_text(candidate, encoding="utf-8")' \
'json.load(tmp.open("r", encoding="utf-8"))' \
'tmp.replace(config_path)' \
| ssh "${REMOTE}" "python3"

echo "[5/6] Install dependencies and start DB API"
ssh "${REMOTE}" "set -e; if ! python3 -m pip --version >/dev/null 2>&1; then if sudo -n true >/dev/null 2>&1; then sudo -n apt-get update && sudo -n apt-get install -y python3-pip; else echo 'python3-pip missing and sudo unavailable' >&2; exit 1; fi; fi"
ssh "${REMOTE}" "cd ${REMOTE_SERVICES}/db_api; python3 -m pip install --user --break-system-packages -r requirements.txt || python3 -m pip install --user -r requirements.txt"

printf '%s\n' \
'[Unit]' \
'Description=OpenClaw DB API' \
'After=network.target' \
'' \
'[Service]' \
'Type=simple' \
"User=${REMOTE_USER}" \
"WorkingDirectory=${REMOTE_SERVICES}/db_api" \
"ExecStart=/usr/bin/python3 ${REMOTE_SERVICES}/db_api/app.py --scenario ${DB_SCENARIO} --host 127.0.0.1 --port 8765" \
'Restart=always' \
'RestartSec=2' \
'Environment=PYTHONUNBUFFERED=1' \
'' \
'[Install]' \
'WantedBy=multi-user.target' \
| ssh "${REMOTE}" "cat > ${REMOTE_BASE}/openclaw-db-api.service"

ssh "${REMOTE}" "set -e; if sudo -n true >/dev/null 2>&1; then sudo -n cp ${REMOTE_BASE}/openclaw-db-api.service /etc/systemd/system/openclaw-db-api.service; sudo -n systemctl daemon-reload; sudo -n systemctl enable --now openclaw-db-api.service; else echo 'ERROR: systemd setup requires passwordless sudo; nohup fallback has been removed.' >&2; exit 1; fi"

echo "[6/6] Verify install"
ssh "${REMOTE}" "python3 -c \"import json; c=json.load(open('${OPENCLAW_JSON}')); ids=[a.get('id') for a in c.get('agents',{}).get('list',[]) if isinstance(a,dict)]; print('REGISTERED', [x for x in ['sre','telemetry','backend','db','verifier','comms'] if x in ids]); print('REMOVED', [x for x in [] if x not in ids])\""
ssh "${REMOTE}" "curl -sS http://127.0.0.1:8765/health"

echo "Install complete on ${REMOTE}."
