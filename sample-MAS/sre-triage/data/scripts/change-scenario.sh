#!/bin/bash
# Copyright (c) 2026 Cisco Systems, Inc. and its affiliates
# SPDX-License-Identifier: Apache-2.0

VALID_SCENARIOS=(1 2)

if [[ $# -eq 0 ]]; then
  echo "Error: scenario number is required." >&2
  echo "Usage: $(basename "$0") <scenario>" >&2
  echo "       valid scenarios: ${VALID_SCENARIOS[*]}" >&2
  exit 1
fi

SCENARIO_NBR="$1"

valid=0
for s in "${VALID_SCENARIOS[@]}"; do
  if [[ "$SCENARIO_NBR" == "$s" ]]; then
    valid=1
    break
  fi
done

if [[ "$valid" -eq 0 ]]; then
  echo "Error: '$SCENARIO_NBR' is not a valid scenario. Valid scenarios: ${VALID_SCENARIOS[*]}" >&2
  exit 1
fi

DB_API_URL="http://127.0.0.1:8765/scenario"

curl -X POST -H "Content-Type: application/json" \
     -d "{\"scenario\": ${SCENARIO_NBR}}" \
     "${DB_API_URL}"
