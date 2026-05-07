#!/usr/bin/env bash

set -euox pipefail

print_help() {
  echo "Usage: $0 [--help|-h] [--cleanup|-c] <NEMOCLAW_VERSION | default: v0.0.30>"
  echo "Example: $0 v0.0.30"
  echo "Optional env vars:"
  echo "  TARGET_DIR=/home/ubuntu/NemoClaw"
  echo "  NEMOCLAW_REPO_URL=https://github.com/NVIDIA/NemoClaw.git"
  echo "  LOCAL_TRIAGE_DIR=/path/to/sample-MAS/sre-triage"
  echo "  NEMOCLAW_PROVIDER=custom"
  echo "  NEMOCLAW_ENDPOINT_URL=https://your-endpoint.example.com"
  echo "  NEMOCLAW_MODEL=vertex_ai/gemini-2.5-pro"
  echo "  NEMOCLAW_DOCKERFILE=~/NemoClaw/Dockerfile"
  echo "  COMPATIBLE_API_KEY=<required>"
  echo "  OTEL_ENDPOINT=<optional, required if using otel-collector.yaml policy -- should be in format http(s)://host:port>"

  echo "Flags:"
  echo "  --help, -h: Show this help message and exit"
  echo "  --cleanup, -c: Clean up installed NemoClaw and related files. Use with caution as this will remove the TARGET_DIR and all its contents."
  exit 0
}

run_cleanup() {
  echo "Cleaning up installed NemoClaw and related files..."
  if [[ -d "${TARGET_DIR}" ]]; then
    rm -rf "${TARGET_DIR}"
    echo "Removed ${TARGET_DIR}"
  else
    echo "No existing installation found at ${TARGET_DIR}. Nothing to clean."
  fi
  exit 0
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_help
fi

if [[ "${1:-}" == "--cleanup" || "${1:-}" == "-c" ]]; then
  run_cleanup
fi

NEMOCLAW_VERSION=${1:-v0.0.30}
TARGET_DIR="${TARGET_DIR:-/home/ubuntu/NemoClaw}"
NEMOCLAW_REPO_URL="${NEMOCLAW_REPO_URL:-https://github.com/NVIDIA/NemoClaw.git}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_TRIAGE_DIR="${LOCAL_TRIAGE_DIR:-${SCRIPT_DIR}/../data/}"
NEMOCLAW_PROVIDER="${NEMOCLAW_PROVIDER:-custom}"
NEMOCLAW_ENDPOINT_URL="${NEMOCLAW_ENDPOINT_URL:-https://your-endpoint.example.com}"
NEMOCLAW_MODEL="${NEMOCLAW_MODEL:-vertex_ai/gemini-2.5-pro}"
NEMOCLAW_DOCKERFILE="${NEMOCLAW_DOCKERFILE:-${TARGET_DIR}/Dockerfile}"
OTEL_ENDPOINT="${OTEL_ENDPOINT:-}"

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
DATA_FOLDER=${SCRIPT_DIR}"/nemoclaw-${NEMOCLAW_VERSION}"

echo "[1/8] Initial checks"

if [[ ! -d ${DATA_FOLDER} ]]; then
  echo "Error: NemoClaw data folder ${DATA_FOLDER} does not exist. Please create it and add necessary files before running the script."
  exit 1
fi

if [[ ! -d ${LOCAL_TRIAGE_DIR} ]]; then
  echo "Error: Local triage directory ${LOCAL_TRIAGE_DIR} does not exist. Please create it and add necessary files before running the script."
  exit 1
fi

if [ -z "${COMPATIBLE_API_KEY:-}" ]; then
  echo "Error: COMPATIBLE_API_KEY environment variable is not set. Please set it to a compatible API key."
  exit 1
fi

[[ $(command -v git) ]] || { echo "Error: git is not installed. Please install git and try again."; exit 1; }
[[ $(command -v node) ]] || { echo "Error: node is not installed. Please install node and try again."; exit 1; }
[[ $(command -v npm) ]] || { echo "Error: npm is not installed. Please install npm and try again."; exit 1; }

NODE_VERSION=$(node --version | sed -E 's/^v([0-9]+).*/\1/')
if [ "${NODE_VERSION}" -lt 22 ]; then
  echo "Error: Node.js version 22 or higher is required. Detected version: ${NODE_VERSION}"
  exit 1
fi

echo "[2/8] Cloning NemoClaw and checking out tag ${NEMOCLAW_VERSION}"

if [[ -d ${TARGET_DIR} ]]; then
  echo "target directory ${TARGET_DIR} already exists. Please remove it or choose a different TARGET_DIR before running the script."
  exit 1
fi

git clone --branch ${NEMOCLAW_VERSION} --depth 1 ${NEMOCLAW_REPO_URL} ${TARGET_DIR}

echo "[3/8] Installing nemoclaw from source"

pushd ${TARGET_DIR}
npm install --ignore-scripts
npm run --if-present build:cli
npm link
popd

echo "[4/8] Applying patches for SRE triage installation"

if [[ -f "${DATA_FOLDER}/git.patch" ]]; then
  pushd ${TARGET_DIR}
  git apply "${DATA_FOLDER}/git.patch"
  popd
else
  echo "Warning: No patch file found at ${DATA_FOLDER}/git.patch. Skipping patch step."
fi

if [[ -d "${DATA_FOLDER}/scripts" ]]; then
  cp -r ${DATA_FOLDER}/scripts/* ${TARGET_DIR}/scripts/
  if [[ -f "${DATA_FOLDER}/scripts/nemoclaw-start.sh" ]]; then
    if [ -n "${OTEL_ENDPOINT}" ]; then
      OTEL_HOST_PORT=$(echo ${OTEL_ENDPOINT} | sed -E 's#^https?://([^/]+).*$#\1#')
      sed -i \
      "s|#REPLACE_OTEL_ENDPOINT_SED_PLACEHOLDER#|${OTEL_ENDPOINT}|g;s|#REPLACE_OTEL_HOST_SED_PLACEHOLDER#|${OTEL_HOST_PORT}|g" \
      ${TARGET_DIR}/scripts/nemoclaw-start.sh
    else
      echo "Warning: OTEL_ENDPOINT environment variable is not set. Observability features will not work."
    fi
  fi
fi

echo "[5/8] Copying SRE triage data"

TARGET_DATA_DIR="${TARGET_DIR}/sre-triage/openclaw"

mkdir -p ${TARGET_DATA_DIR}
cp -r ${LOCAL_TRIAGE_DIR}/workspaces ${TARGET_DATA_DIR}/
cp -r ${LOCAL_TRIAGE_DIR}/services ${TARGET_DATA_DIR}/
cp -r ${LOCAL_TRIAGE_DIR}/scripts ${TARGET_DATA_DIR}/

echo "[6/8] Copying observability plugin"

OBSERVABILITY_PLUGIN_DIR="${SCRIPT_DIR}/../../../observability-plugin"
if [[ -d "${OBSERVABILITY_PLUGIN_DIR}" ]]; then
  cp -r ${OBSERVABILITY_PLUGIN_DIR} ${TARGET_DIR}
else
  echo "Warning: No observability plugin found at ${OBSERVABILITY_PLUGIN_DIR}. Skipping observability plugin copy."
fi

echo "[7/8] Onboarding to NemoClaw"
NEMOCLAW_NON_INTERACTIVE=1 \
NEMOCLAW_RECREATE_SANDBOX=1 \
NEMOCLAW_PROVIDER=${NEMOCLAW_PROVIDER} \
NEMOCLAW_ENDPOINT_URL=${NEMOCLAW_ENDPOINT_URL} \
NEMOCLAW_MODEL=${NEMOCLAW_MODEL} \
COMPATIBLE_API_KEY=${COMPATIBLE_API_KEY:-} \
nemoclaw onboard --non-interactive --from ${NEMOCLAW_DOCKERFILE} --yes-i-accept-third-party-software --name my-assistant

echo "[8/8] Apply custom network policies for nemoclaw if needed"

if [[ -d "${DATA_FOLDER}/policies" ]]; then
  mkdir -p ${TARGET_DIR}/custom-policies/
  cp ${DATA_FOLDER}/policies/* ${TARGET_DIR}/custom-policies/
  if [[ -f "${DATA_FOLDER}/policies/otel-collector.yaml" ]]; then
    if [ -n "${OTEL_ENDPOINT}" ]; then
      OTEL_HOST=$(echo ${OTEL_ENDPOINT} | sed -E 's#^https?://([^:/]+).*$#\1#') # Keep only the host part for the policy
      sed "s/#{OTEL_ENDPOINT}/${OTEL_HOST}/" ${DATA_FOLDER}/policies/otel-collector.yaml > ${TARGET_DIR}/custom-policies/otel-collector.yaml
    else
      echo "Warning: OTEL_ENDPOINT environment variable is not set. Skipping otel-collector.yaml policy which requires OTEL_ENDPOINT to be set."
      rm ${TARGET_DIR}/custom-policies/otel-collector.yaml
    fi
  fi
  for policy in ${TARGET_DIR}/custom-policies/*.yaml; do
    nemoclaw my-assistant policy-add --yes --from-file $policy
  done
fi

echo "Installation complete. SRE triage sample MAS is set up and can be accessed via nemoclaw my-assistant connect."
