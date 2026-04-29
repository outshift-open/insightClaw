#!/usr/bin/env bash
set -euox pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <target_user@target_host>"
  echo "Optional env vars:"
  echo "  TARGET_DIR=/home/ubuntu/NemoClaw"
  echo "  NEMOCLAW_REPO_URL=https://github.com/NVIDIA/NemoClaw.git"
  echo "  NEMOCLAW_TAG=v0.0.20"
  echo "  DIFF_FILE=/path/to/nemoclaw-nuc-v0.0.20.diff"
  echo "  LOCAL_TRIAGE_DIR=/path/to/sample-MAS/sre-triage"
  echo "  REMOTE_TRIAGE_DIR=~/NemoClaw/sre-triage"
  echo "  NEMOCLAW_PROVIDER=custom"
  echo "  NEMOCLAW_ENDPOINT_URL=https://your-endpoint.example.com"
  echo "  NEMOCLAW_MODEL=vertex_ai/gemini-2.5-pro"
  echo "  NEMOCLAW_ONBOARD_FROM=~/NemoClaw/Dockerfile"
  echo "  COMPATIBLE_API_KEY=<required>"
  echo "  DRY_RUN=1"
  echo "  CLEAN=1"
  exit 1
fi

TARGET_HOST="$1"
TARGET_DIR="${TARGET_DIR:-/home/ubuntu/NemoClaw}"
NEMOCLAW_REPO_URL="${NEMOCLAW_REPO_URL:-https://github.com/NVIDIA/NemoClaw.git}"
NEMOCLAW_TAG="${NEMOCLAW_TAG:-v0.0.20}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIFF_FILE="${DIFF_FILE:-${SCRIPT_DIR}/nemoclaw-nuc-v0.0.20.diff}"
LOCAL_TRIAGE_DIR="${LOCAL_TRIAGE_DIR:-${SCRIPT_DIR}/..}"
REMOTE_TRIAGE_DIR="${REMOTE_TRIAGE_DIR:-${TARGET_DIR}/sre-triage}"
REMOTE_TRIAGE_OPENCLAW_DIR="${REMOTE_TRIAGE_DIR}/openclaw"
REMOTE_DIFF="${TARGET_DIR}/.nemoclaw-local.diff"
NEMOCLAW_PROVIDER="${NEMOCLAW_PROVIDER:-custom}"
NEMOCLAW_ENDPOINT_URL="${NEMOCLAW_ENDPOINT_URL:-https://your-endpoint.example.com}"
NEMOCLAW_MODEL="${NEMOCLAW_MODEL:-vertex_ai/gemini-2.5-pro}"
NEMOCLAW_ONBOARD_FROM="${NEMOCLAW_ONBOARD_FROM:-${TARGET_DIR}/Dockerfile}"
DRY_RUN="${DRY_RUN:-0}"
CLEAN="${CLEAN:-0}"

is_dry_run() {
  [ "${DRY_RUN}" = "1" ]
}

run_local() {
  echo "+ $*"
  if ! is_dry_run; then
    "$@"
  fi
}

run_copy() {
  echo "+ scp $*"
  if ! is_dry_run; then
    scp "$@"
  fi
}

run_remote() {
  local script="$1"

  echo "+ ssh ${TARGET_HOST} bash -se <<'EOF'"
  printf '%s\n' "${script}"
  echo "EOF"

  if ! is_dry_run; then
    ssh "${TARGET_HOST}" bash -se <<<"${script}"
  fi
}

echo "[1/7] Validating local assets and target connectivity"
if [ "${CLEAN}" != "1" ]; then
  test -f "${DIFF_FILE}"
  test -d "${LOCAL_TRIAGE_DIR}"
fi

if [ "${CLEAN}" != "1" ] && ! is_dry_run && [ -z "${COMPATIBLE_API_KEY:-}" ]; then
  echo "COMPATIBLE_API_KEY must be set before onboarding NemoClaw." >&2
  exit 1
fi

if [ "${CLEAN}" = "1" ]; then
  run_remote "
    set -euo pipefail
    rm -rf ${TARGET_DIR}
    rm -rf ${REMOTE_TRIAGE_DIR}
  "
  if is_dry_run; then
    echo "Dry run clean complete. No remote changes were made."
  else
    echo "Clean complete. Removed ${TARGET_DIR} and ${REMOTE_TRIAGE_DIR} on ${TARGET_HOST}."
  fi
  exit 0
fi

echo "[2/7] Ensuring remote prerequisites (git + node + npm)"
run_remote "
  set -euo pipefail
  command -v git >/dev/null

  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    NODE_MAJOR=\"\$(node -v | sed -E 's/^v([0-9]+).*/\1/')\"
    if [ \"\${NODE_MAJOR}\" -ge 22 ]; then
      exit 0
    fi
  fi

  export NVM_DIR=\"\${NVM_DIR:-\$HOME/.nvm}\"
  if [ ! -s \"\$NVM_DIR/nvm.sh\" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi

  # shellcheck disable=SC1090
  . \"\$NVM_DIR/nvm.sh\"
  nvm install 22
  nvm use 22

  command -v node >/dev/null 2>&1
  command -v npm >/dev/null 2>&1
  NODE_MAJOR=\"\$(node -v | sed -E 's/^v([0-9]+).*/\1/')\"
  [ \"\${NODE_MAJOR}\" -ge 22 ]
"

echo "[3/7] Cloning NemoClaw on target and checking out ${NEMOCLAW_TAG}"
run_remote "
  set -euo pipefail
  mkdir -p ${TARGET_DIR}
  if [ ! -d ${TARGET_DIR}/.git ]; then
    git clone ${NEMOCLAW_REPO_URL} ${TARGET_DIR}
  fi
  cd ${TARGET_DIR}
  git fetch --all --tags --force
  git checkout -f tags/${NEMOCLAW_TAG}
  git clean -fdx
"

echo "[4/7] Installing nemoclaw CLI from source"
run_remote "
  set -euo pipefail
  export NVM_DIR=\"\${NVM_DIR:-\$HOME/.nvm}\"
  # shellcheck disable=SC1090
  . \"\$NVM_DIR/nvm.sh\"
  nvm use 22 >/dev/null
  cd ${TARGET_DIR}
  npm install --ignore-scripts
  npm run --if-present build:cli
  npm link
"

echo "[5/7] Applying local diff on target"
run_copy "${DIFF_FILE}" "${TARGET_HOST}:${REMOTE_DIFF}"
run_remote "
  set -euo pipefail
  cd ${TARGET_DIR}
  git apply --check ${REMOTE_DIFF}
  git apply ${REMOTE_DIFF}
  rm -f ${REMOTE_DIFF}
"

echo "[6/7] Copying SRE triage sample and running onboarding"
run_remote "
  set -euo pipefail
  rm -rf ${REMOTE_TRIAGE_DIR}
  mkdir -p ${REMOTE_TRIAGE_OPENCLAW_DIR}
"

echo "+ cd ${LOCAL_TRIAGE_DIR} && tar --exclude=nemoclaw -cf - . | ssh ${TARGET_HOST} 'tar -C ${REMOTE_TRIAGE_OPENCLAW_DIR} -xf -'"
if ! is_dry_run; then
  (cd "${LOCAL_TRIAGE_DIR}" && tar --exclude=nemoclaw -cf - . | ssh "${TARGET_HOST}" "tar -C ${REMOTE_TRIAGE_OPENCLAW_DIR} -xf -")
fi
run_remote "
  set -euo pipefail
  export NVM_DIR=\"\${NVM_DIR:-\$HOME/.nvm}\"
  # shellcheck disable=SC1090
  . \"\$NVM_DIR/nvm.sh\"
  nvm use 22 >/dev/null
  cd ${TARGET_DIR}
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  NEMOCLAW_PROVIDER='${NEMOCLAW_PROVIDER}' \
  NEMOCLAW_ENDPOINT_URL='${NEMOCLAW_ENDPOINT_URL}' \
  NEMOCLAW_MODEL='${NEMOCLAW_MODEL}' \
  COMPATIBLE_API_KEY='${COMPATIBLE_API_KEY:-}' \
  nemoclaw onboard --non-interactive --recreate-sandbox --from '${NEMOCLAW_ONBOARD_FROM}' --yes-i-accept-third-party-software
"

echo "[7/7] Verifying target repository state"
run_remote "
  set -euo pipefail
  cd ${TARGET_DIR}
  echo 'HEAD:'
  git --no-pager log --oneline -1
  echo
  echo 'Changed files after applying local diff:'
  git --no-pager status --short -- . ':(exclude)sre-triage/**'
"

if is_dry_run; then
  echo "Dry run complete. No remote changes were made."
else
  echo "Done. NemoClaw is prepared on ${TARGET_HOST}, sample-MAS/sre-triage was copied into ${REMOTE_TRIAGE_DIR}, and onboarding completed."
fi