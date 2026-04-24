#!/bin/bash
set -euo pipefail

# Remove all existing sessions
rm ~/.openclaw/agents/sre/sessions/* || true
rm ~/.openclaw/agents/backend/sessions/* || true
rm ~/.openclaw/agents/db/sessions/* || true
rm ~/.openclaw/agents/telemetry/sessions/* || true
rm ~/.openclaw/agents/comms/sessions/* || true
rm ~/.openclaw/agents/verifier/sessions/* || true

# Create sessions for verifier and comms
openclaw agent --agent verifier --session-id verifier-session --message "who are you?"
openclaw agent --agent comms --session-id comms-session --message "who are you?"

#openclaw sessions --all-agents
