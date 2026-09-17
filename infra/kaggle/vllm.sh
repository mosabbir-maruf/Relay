#!/usr/bin/env bash
# Generic Hugging Face -> vLLM lifecycle manager for Kaggle dual T4.
set -euo pipefail

WORK_DIR="${WORK_DIR:-/kaggle/working}"
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
MODEL_ID="${MODEL_ID:-}"
PID_FILE="${WORK_DIR}/vllm.pid"
LOG_FILE="${WORK_DIR}/vllm_server.log"
PORT="${VLLM_PORT:-8000}"
PREFLIGHT_JSON="${WORK_DIR}/vllm-preflight.json"

preflight() {
  MODEL_ID="${MODEL_ID}" python3 "${REPO_DIR}/infra/kaggle/preflight.py" --json > "${PREFLIGHT_JSON}"
  MODEL_ID="${MODEL_ID}" python3 "${REPO_DIR}/infra/kaggle/preflight.py"
}

check() {
  command -v nvidia-smi >/dev/null || { echo "ERROR: nvidia-smi not found. Enable Kaggle GPU." >&2; return 1; }
  nvidia-smi --query-gpu=name,compute_cap,memory.total --format=csv,noheader,nounits
  command -v vllm >/dev/null || { echo "ERROR: vllm CLI not found. Install vllm==0.29.0 first." >&2; return 1; }
  vllm --version
  if command -v ss >/dev/null && ss -ltn "sport = :${PORT}" | grep -q LISTEN; then
    echo "WARNING: port ${PORT} is occupied"
  else
    echo "Port ${PORT}: available"
  fi
}

start() {
  [ -n "${MODEL_ID}" ] || { echo "ERROR: MODEL_ID is required." >&2; return 2; }
  mkdir -p "${WORK_DIR}"
  if [ -f "${PID_FILE}" ] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
    echo "vLLM already running (PID $(cat "${PID_FILE}"))."; return 0
  fi
  preflight >/dev/null
  python3 - "${PREFLIGHT_JSON}" <<'PY'
import json, sys
p=json.load(open(sys.argv[1]))
print("Launching:")
print(" "+" ".join(p["command"]))
PY
  rm -f "${LOG_FILE}" "${PID_FILE}"
  mapfile -t CMD < <(python3 - "${PREFLIGHT_JSON}" <<'PY'
import json,sys,shlex
for x in json.load(open(sys.argv[1]))["command"]: print(x)
PY
)
  nohup "${CMD[@]}" >"${LOG_FILE}" 2>&1 &
  echo $! > "${PID_FILE}"
  echo "vLLM launched (PID $(cat "${PID_FILE}")). Logs: ${LOG_FILE}"
}

status() {
  local pid=""
  [ -f "${PID_FILE}" ] && pid=$(cat "${PID_FILE}" 2>/dev/null || true)
  if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
    echo "vLLM: RUNNING (PID ${pid})"
  else
    echo "vLLM: NOT RUNNING"; return 1
  fi
  python3 - <<PY
import json, urllib.request
try:
    with urllib.request.urlopen('http://127.0.0.1:${PORT}/v1/models', timeout=3) as r:
        data=json.load(r); print('API: READY'); print('Models:', ', '.join(x.get('id','?') for x in data.get('data',[])))
except Exception as e:
    print('API: NOT READY:', e); raise SystemExit(1)
PY
}

test_api() {
  local model="${SERVED_MODEL_NAME:-${MODEL_ID##*/}}"
  python3 - "${model}" <<'PY'
import json,sys,time,urllib.request
model=sys.argv[1]
payload=json.dumps({'model':model,'messages':[{'role':'user','content':'Reply with exactly PONG.'}],'max_tokens':8}).encode()
req=urllib.request.Request('http://127.0.0.1:8000/v1/chat/completions',data=payload,headers={'Content-Type':'application/json'},method='POST')
t=time.monotonic()
with urllib.request.urlopen(req,timeout=60) as r:
    body=json.load(r)
print('Status:', r.status)
print('Model:', body.get('model'))
print('Response:', body.get('choices',[{}])[0].get('message',{}).get('content','')[:200])
print('Latency: %.0f ms' % ((time.monotonic()-t)*1000))
PY
}

stop() {
  if [ -f "${PID_FILE}" ]; then
    pid=$(cat "${PID_FILE}" 2>/dev/null || true)
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then kill "${pid}" 2>/dev/null || true; sleep 2; kill -9 "${pid}" 2>/dev/null || true; fi
    rm -f "${PID_FILE}"
  fi
  echo "vLLM stopped."
}

clean() {
  stop || true
  if command -v fuser >/dev/null; then fuser -k "${PORT}/tcp" 2>/dev/null || true; fi
  sleep 2
  echo "Stale port/process cleanup complete."
}

logs() { tail -n "${2:-50}" "${LOG_FILE}" 2>/dev/null || echo "No log file: ${LOG_FILE}"; }

case "${1:-status}" in
  check) check;; preflight) preflight;; start) start;; status) status;; test) test_api;; logs) logs "$@";; stop) stop;; clean) clean;;
  *) echo "Usage: $0 {check|preflight|start|status|test|logs [lines]|stop|clean}"; exit 1;;
esac
