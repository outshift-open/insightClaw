#!/bin/bash

# Remove all existing sessions
AGENT_SESSION_DIR=/sandbox/.openclaw-data/agents
rm ${AGENT_SESSION_DIR}/sre/sessions/* || true
rm ${AGENT_SESSION_DIR}/backend/sessions/* || true
rm ${AGENT_SESSION_DIR}/db/sessions/* || true
rm ${AGENT_SESSION_DIR}/telemetry/sessions/* || true
rm ${AGENT_SESSION_DIR}/comms/sessions/* || true
rm ${AGENT_SESSION_DIR}/verifier/sessions/* || true

# Create sessions for verifier and comms
openclaw agent --agent verifier --session-id verifier-session --message "who are you?"
openclaw agent --agent comms --session-id comms-session --message "who are you?"
