#!/usr/bin/env bash
# ==============================================================================
# Relay Kaggle Infrastructure: Cloudflare Quick Tunnel Management
#
# Manages the temporary development Cloudflare Quick Tunnel on Kaggle.
# Usage:
#   ./cloudflared.sh check   - Verify or download cloudflared binary
#   ./cloudflared.sh start   - Start tunnel in background and extract public URL
#   ./cloudflared.sh status  - Check tunnel process status
#   ./cloudflared.sh url     - Print current dynamic trycloudflare.com URL
#   ./cloudflared.sh logs    - View cloudflared logs
#   ./cloudflared.sh stop    - Terminate running tunnel
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${WORK_DIR:-/kaggle/working}"
BIN_PATH="${WORK_DIR}/cloudflared"
LOG_FILE="${WORK_DIR}/cloudflared.log"
PID_FILE="${WORK_DIR}/cloudflared.pid"
URL_FILE="${WORK_DIR}/public_tunnel_url.txt"
LOCAL_TARGET="${LOCAL_TARGET:-http://127.0.0.1:8000}"
CLOUDFLARED_VERSION="${CLOUDFLARED_VERSION:-latest}"

ensure_binary() {
  if [ -x "${BIN_PATH}" ]; then
    echo "cloudflared binary found at: ${BIN_PATH}"
    "${BIN_PATH}" --version
    return 0
  fi

  echo "cloudflared binary not found at ${BIN_PATH}. Downloading official release (version: ${CLOUDFLARED_VERSION})..."
  mkdir -p "${WORK_DIR}"
  local download_url
  if [ "${CLOUDFLARED_VERSION}" = "latest" ]; then
    download_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
  else
    download_url="https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64"
  fi
  wget -q -nc "${download_url}" -O "${BIN_PATH}"
  chmod +x "${BIN_PATH}"
  echo "Downloaded and marked executable:"
  "${BIN_PATH}" --version
}

extract_url() {
  if [ -f "${URL_FILE}" ]; then
    local cached_url
    cached_url=$(cat "${URL_FILE}" 2>/dev/null | tr -d '[:space:]' || true)
    if [[ "${cached_url}" =~ ^https://[a-zA-Z0-9-]+\.trycloudflare\.com ]]; then
      echo "${cached_url}"
      return 0
    fi
  fi

  if [ ! -f "${LOG_FILE}" ]; then
    echo "ERROR: Log file ${LOG_FILE} does not exist." >&2
    return 1
  fi

  local url
  url=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' "${LOG_FILE}" | tail -n 1 || true)
  if [ -n "${url}" ]; then
    echo "${url}" > "${URL_FILE}" 2>/dev/null || true
    echo "${url}"
    return 0
  else
    echo "ERROR: No active trycloudflare.com URL found in ${LOG_FILE}." >&2
    return 1
  fi
}

start_tunnel() {
  ensure_binary

  if [ -f "${PID_FILE}" ]; then
    local existing_pid
    existing_pid=$(cat "${PID_FILE}" 2>/dev/null || true)
    if [ -n "${existing_pid}" ] && kill -0 "${existing_pid}" 2>/dev/null; then
      echo "cloudflared is already running (PID ${existing_pid})."
      local cur_url
      cur_url=$(extract_url 2>/dev/null || true)
      if [ -n "${cur_url}" ]; then
        echo "Current Public URL: ${cur_url}"
        echo "PUBLIC_URL=${cur_url}"
        echo "BASE_URL=${cur_url}/v1"
        echo "PUBLIC_TUNNEL_URL=${cur_url}"
      else
        echo "Current Public URL: checking..."
      fi
      return 0
    fi
  fi

  echo "Starting Cloudflare Quick Tunnel pointing to ${LOCAL_TARGET}..."
  rm -f "${LOG_FILE}" "${PID_FILE}" "${URL_FILE}"

  if command -v setsid >/dev/null 2>&1; then
    setsid "${BIN_PATH}" tunnel --url "${LOCAL_TARGET}" --logfile "${LOG_FILE}" >/dev/null 2>&1 &
  else
    nohup "${BIN_PATH}" tunnel --url "${LOCAL_TARGET}" --logfile "${LOG_FILE}" >/dev/null 2>&1 &
  fi
  local pid=$!
  disown -a 2>/dev/null || true
  echo "${pid}" > "${PID_FILE}"
  echo "cloudflared process launched (PID ${pid})"

  echo "Waiting up to 30 seconds for public tunnel URL..."
  local tunnel_url=""
  for i in {1..30}; do
    sleep 1
    if [ -f "${LOG_FILE}" ]; then
      tunnel_url=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' "${LOG_FILE}" | tail -n 1 || true)
      if [ -n "${tunnel_url}" ]; then
        break
      fi
    fi
  done

  if [ -n "${tunnel_url}" ]; then
    echo "${tunnel_url}" > "${URL_FILE}" 2>/dev/null || true
    echo -e "\n========================================================"
    echo "Cloudflare Quick Tunnel process launched and URL captured."
    echo "Public URL: ${tunnel_url}"
    echo "Base URL:   ${tunnel_url}/v1"
    echo "NOTE: Public hostname propagation & endpoint readiness must be verified."
    echo "========================================================"
    echo "PUBLIC_URL=${tunnel_url}"
    echo "BASE_URL=${tunnel_url}/v1"
    echo "PUBLIC_TUNNEL_URL=${tunnel_url}"
    local model_alias="${SERVED_MODEL_NAME:-}"
    if [ -z "${model_alias}" ] && [ -f "${WORK_DIR}/served_model_name.txt" ]; then
      model_alias=$(cat "${WORK_DIR}/served_model_name.txt" 2>/dev/null || true)
    fi
    if [ -z "${model_alias}" ] && [ -f "${WORK_DIR}/resolved_config.json" ]; then
      model_alias=$(python3 -c "import json; print(json.load(open('${WORK_DIR}/resolved_config.json')).get('served_model_name', ''))" 2>/dev/null || true)
    fi
    if [ -z "${model_alias}" ] && [ -n "${MODEL_ID:-}" ]; then
      model_alias=$(python3 -c "import sys, os; sys.path.insert(0, '${SCRIPT_DIR}'); import preflight; print(preflight.sanitize_served_name('${MODEL_ID}'))" 2>/dev/null || true)
    fi

    if [ -n "${model_alias}" ]; then
      echo "MODEL=${model_alias}"
    elif [ -n "${QWEN_MODEL:-}" ]; then
      echo "QWEN_BASE_URL=${tunnel_url}/v1"
      echo "QWEN_MODEL=${QWEN_MODEL}"
    fi
  else
    echo "WARNING: Tunnel process started (PID ${pid}), but URL not detected yet."
    echo "Check logs with: tail -n 20 ${LOG_FILE}"
  fi
}

status_tunnel() {
  if [ -f "${PID_FILE}" ]; then
    local pid
    pid=$(cat "${PID_FILE}" 2>/dev/null || true)
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
      echo "cloudflared: RUNNING (PID ${pid})"
      local url
      url=$(extract_url 2>/dev/null || true)
      if [ -n "${url}" ]; then
        echo "Public URL: ${url}"
      else
        echo "Public URL: (pending in log)"
      fi
      return 0
    fi
  fi

  echo "cloudflared: NOT RUNNING"
  return 1
}

stop_tunnel() {
  echo "Stopping Cloudflare Tunnel..."
  if [ -f "${PID_FILE}" ]; then
    local pid
    pid=$(cat "${PID_FILE}" 2>/dev/null || true)
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
      sleep 1
      if kill -0 "${pid}" 2>/dev/null; then
        kill -9 "${pid}" 2>/dev/null || true
      fi
      echo "Stopped cloudflared (PID ${pid})."
    else
      echo "cloudflared (PID ${pid}) was not running."
    fi
    rm -f "${PID_FILE}" "${URL_FILE}"
  else
    echo "No PID file found at ${PID_FILE}."
    rm -f "${URL_FILE}"
  fi
}

show_logs() {
  local lines="${2:-50}"
  if [ -f "${LOG_FILE}" ]; then
    tail -n "${lines}" "${LOG_FILE}"
  else
    echo "Log file ${LOG_FILE} does not exist."
  fi
}

case "${1:-status}" in
  check)
    ensure_binary
    ;;
  start)
    start_tunnel
    ;;
  status)
    status_tunnel
    ;;
  url)
    extract_url
    ;;
  stop)
    stop_tunnel
    ;;
  logs)
    show_logs "${@}"
    ;;
  *)
    echo "Usage: $0 {check|start|status|url|logs [lines]|stop}"
    exit 1
    ;;
esac
