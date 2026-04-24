#!/bin/bash

#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <scenario>" >&2
  exit 1
fi

SCENARIO="$1"

if ! [[ "$SCENARIO" =~ ^[0-9]+$ ]] || [[ "$SCENARIO" -lt 1 ]] || [[ "$SCENARIO" -gt 2 ]]; then
  echo "Error: scenario must be an integer between 1 and 2 (got: $SCENARIO)" >&2
  exit 1
fi

cat << EOF > ~/.config/systemd/user/openclaw-db-api.service
[Unit]
Description=OpenClaw DB API
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/.openclaw/services/db_api
ExecStart=/usr/bin/python3 /home/ubuntu/.openclaw/services/db_api/app.py --host 127.0.0.1 --port 8765 --scenario $SCENARIO
Restart=always
RestartSec=2
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=default.target
EOF

# Reload the daemon
systemctl --user daemon-reload

# Restart the service
systemctl restart --user openclaw-db-api

# wait for it
sleep 2

echo $HOME
# test to see that everything is ok
curl -sS http://127.0.0.1:8765/scenario

