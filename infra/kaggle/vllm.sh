#!/usr/bin/env bash
# ==============================================================================
# Relay Kaggle Infrastructure: Generic Hugging Face / vLLM Server Management
#
# Parameter-driven, model-agnostic management script for self-hosted vLLM
# backends on Kaggle dual NVIDIA Tesla T4 GPUs.
#
# Supported Commands:
#   ./vllm.sh check      - Validate prerequisites, GPUs, vLLM, and port 8000
#   ./vllm.sh preflight  - Inspect target HF model & validate T4 compatibility
#   ./vllm.sh clean      - Safely clean up stale vLLM processes on port 8000
#   ./vllm.sh start      - Resolve config & launch vLLM in background
#   ./vllm.sh status     - Check process status and endpoint readiness
#   ./vllm.sh test       - Run a local OpenAI-compatible inference test
#   ./vllm.sh logs [N]   - View the latest N server logs (default: 100)
#   ./vllm.sh stop       - Safely terminate vLLM and verify GPU memory release
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${WORK_DIR:-/kaggle/working}"
LOG_FILE="${WORK_DIR}/vllm_server.log"
PID_FILE="${WORK_DIR}/vllm.pid"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"

# Export CUDA 13 runtime path if present in Kaggle environment
if [ -d "/usr/local/lib/python3.12/dist-packages/nvidia/cu13/lib" ]; then
  export LD_LIBRARY_PATH="/usr/local/lib/python3.12/dist-packages/nvidia/cu13/lib:${LD_LIBRARY_PATH:-}"
fi

check_env() {
  echo "=== [1/3] Checking GPU Hardware ==="
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "ERROR: nvidia-smi not found. Ensure GPU accelerator is enabled in Kaggle settings." >&2
    return 1
  fi

  local gpu_count
  gpu_count=$(nvidia-smi --query-gpu=name --format=csv,noheader | wc -l)
  echo "Detected ${gpu_count} GPU(s):"
  nvidia-smi --query-gpu=index,name,memory.total,memory.free --format=csv,noheader

  local target_tp="${TENSOR_PARALLEL_SIZE:-2}"
  if [ "${gpu_count}" -lt "${target_tp}" ]; then
    echo "WARNING: Detected ${gpu_count} GPU(s), but target tensor-parallel-size is ${target_tp}." >&2
  fi

  echo -e "\n=== [2/3] Checking vLLM Installation ==="
  if command -v vllm >/dev/null 2>&1; then
    echo "vLLM CLI available: $(command -v vllm)"
    vllm --version || true
  else
    echo "ERROR: 'vllm' binary not found on PATH." >&2
    echo "Remediation: pip install -q --no-cache-dir vllm==0.29.0" >&2
    return 1
  fi

  echo -e "\n=== [3/3] Checking Port ${PORT} ==="
  if command -v lsof >/dev/null 2>&1; then
    if lsof -i ":${PORT}" >/dev/null 2>&1; then
      echo "WARNING: Port ${PORT} is currently in use."
      lsof -i ":${PORT}"
    else
      echo "Port ${PORT} is free."
    fi
  else
    echo "lsof not installed; skipping port check."
  fi
}

run_preflight() {
  if [ -z "${MODEL_ID:-}" ]; then
    echo "ERROR: MODEL_ID environment variable is not set." >&2
    echo "Example: export MODEL_ID='Qwen/Qwen2.5-Coder-7B-Instruct'" >&2
    return 1
  fi

  python3 "${SCRIPT_DIR}/preflight.py"
}

clean_stale() {
  echo "Checking for stale processes on port ${PORT}..."

  local killed=0
  if [ -f "${PID_FILE}" ]; then
    local recorded_pid
    recorded_pid=$(cat "${PID_FILE}" 2>/dev/null || true)
    if [ -n "${recorded_pid}" ] && kill -0 "${recorded_pid}" 2>/dev/null; then
      echo "Stopping recorded vLLM PID ${recorded_pid}..."
      kill "${recorded_pid}" 2>/dev/null || true
      sleep 2
      if kill -0 "${recorded_pid}" 2>/dev/null; then
        kill -9 "${recorded_pid}" 2>/dev/null || true
      fi
      killed=1
    fi
    rm -f "${PID_FILE}"
  fi

  # Check if port 8000 is still held
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids=$(lsof -ti ":${PORT}" 2>/dev/null || true)
    if [ -n "${pids}" ]; then
      echo "Found active process(es) holding port ${PORT}: ${pids}"
      for p in ${pids}; do
        local comm
        comm=$(ps -p "${p}" -o comm= 2>/dev/null || true)
        if [[ "${comm}" =~ python|vllm ]]; then
          echo "Terminating stale vLLM process (PID ${p}, command: ${comm})..."
          kill "${p}" 2>/dev/null || true
          sleep 1
          kill -9 "${p}" 2>/dev/null || true
          killed=1
        fi
      done
    fi
  fi

  if [ "${killed}" -eq 1 ]; then
    echo "Cleanup complete. Waiting 3 seconds for GPU memory release..."
    sleep 3
  else
    echo "No stale vLLM processes detected on port ${PORT}."
  fi

  if command -v nvidia-smi >/dev/null 2>&1; then
    echo "Current GPU Memory:"
    nvidia-smi --query-gpu=index,memory.used,memory.free --format=csv,noheader
  fi
}

start_server() {
  if [ -f "${PID_FILE}" ]; then
    local existing_pid
    existing_pid=$(cat "${PID_FILE}" 2>/dev/null || true)
    if [ -n "${existing_pid}" ] && kill -0 "${existing_pid}" 2>/dev/null; then
      echo "ERROR: vLLM is already running (PID ${existing_pid})." >&2
      echo "Use './vllm.sh status' to inspect, or './vllm.sh stop' before restarting." >&2
      return 1
    fi
  fi

  # Check if vllm is installed
  if ! command -v vllm >/dev/null 2>&1; then
    echo "ERROR: 'vllm' binary not found on PATH." >&2
    echo "Remediation: pip install -q --no-cache-dir vllm==0.29.0" >&2
    return 1
  fi

  # Check if port is occupied
  if command -v lsof >/dev/null 2>&1 && lsof -i ":${PORT}" >/dev/null 2>&1; then
    echo "ERROR: Port ${PORT} is already occupied. Run './vllm.sh clean' first." >&2
    return 1
  fi

  if [ -z "${MODEL_ID:-}" ]; then
    echo "ERROR: MODEL_ID is not set. Export MODEL_ID before starting." >&2
    return 1
  fi

  echo "Running preflight validation..."
  local preflight_json
  if ! preflight_json=$(python3 "${SCRIPT_DIR}/preflight.py" --json); then
    echo "ERROR: Preflight validation failed! Output:" >&2
    echo "${preflight_json}" >&2
    return 1
  fi

  # Extract diagnostic metadata and executable argv array from JSON
  local served_name
  served_name=$(echo "${preflight_json}" | python3 -c "import sys, json; print(json.load(sys.stdin).get('served_model_name', ''))")

  local cmd_str
  cmd_str=$(echo "${preflight_json}" | python3 -c "import sys, json; print(json.load(sys.stdin).get('command_str', ''))")

  # Reconstruct argv array from preflight's authoritative command_args
  local cmd_args=()
  while IFS= read -r -d '' arg; do
    cmd_args+=("${arg}")
  done < <(echo "${preflight_json}" | python3 -c "import sys, json
data = json.load(sys.stdin)
for a in data.get('command_args', []):
    sys.stdout.buffer.write(a.encode('utf-8') + b'\x00')
")

  if [ "${#cmd_args[@]}" -lt 3 ]; then
    echo "ERROR: Malformed command arguments array from preflight. Expected at least 'vllm serve <MODEL_ID>'." >&2
    return 1
  fi

  # Resolve absolute path to vllm binary if available on PATH
  local vllm_bin
  vllm_bin=$(command -v "${cmd_args[0]}" 2>/dev/null || true)
  if [ -n "${vllm_bin}" ]; then
    cmd_args[0]="${vllm_bin}"
  fi

  mkdir -p "${WORK_DIR}"
  echo "Launching vLLM in background..."
  echo "Model ID:    ${MODEL_ID}"
  echo "Served Name: ${served_name}"
  echo "Log file:    ${LOG_FILE}"
  echo "Command:     ${cmd_str}"

  # Launch directly using argv array without eval or shell string reconstruction
  nohup "${cmd_args[@]}" > "${LOG_FILE}" 2>&1 &
  local server_pid=$!
  echo "${server_pid}" > "${PID_FILE}"
  echo "vLLM process launched with PID: ${server_pid}"

  echo "Waiting 3 seconds for initial process confirmation..."
  sleep 3
  if ! kill -0 "${server_pid}" 2>/dev/null; then
    echo "ERROR: vLLM process exited immediately! Showing last 30 log lines:" >&2
    tail -n 30 "${LOG_FILE}" >&2
    rm -f "${PID_FILE}"
    return 1
  fi

  echo "vLLM is running. Run './vllm.sh status' or follow logs: tail -f ${LOG_FILE}"
}

status_server() {
  local is_running=0
  local pid=""

  if [ -f "${PID_FILE}" ]; then
    pid=$(cat "${PID_FILE}" 2>/dev/null || true)
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
      is_running=1
    fi
  fi

  if [ "${is_running}" -eq 1 ]; then
    echo "Process: RUNNING (PID ${pid})"
  else
    echo "Process: NOT RUNNING"
    if [ -f "${LOG_FILE}" ]; then
      echo "Last 10 lines of ${LOG_FILE}:"
      tail -n 10 "${LOG_FILE}"
    fi
    return 1
  fi

  echo -e "\nProbing local endpoint http://127.0.0.1:${PORT}/v1/models..."
  if command -v curl >/dev/null 2>&1; then
    local res
    if res=$(curl -s --connect-timeout 2 "http://127.0.0.1:${PORT}/v1/models"); then
      echo "Endpoint Status: ONLINE (HTTP 200)"
      echo "Available models:"
      echo "${res}"
    else
      echo "Endpoint Status: INITIALIZING (vLLM is still loading weights/compiling KV cache)"
      echo "Check progress: tail -n 20 ${LOG_FILE}"
    fi
  fi
}

test_inference() {
  echo "Resolving served model name for inference test..."
  local target_model="${SERVED_MODEL_NAME:-}"

  if [ -z "${target_model}" ]; then
    # Probe local endpoint for registered model
    if command -v curl >/dev/null 2>&1; then
      target_model=$(curl -s --connect-timeout 3 "http://127.0.0.1:${PORT}/v1/models" | \
        python3 -c "import sys, json; data=json.load(sys.stdin); models=data.get('data', []); print(models[0]['id'] if models else '')" 2>/dev/null || true)
    fi
  fi

  if [ -z "${target_model}" ] && [ -n "${MODEL_ID:-}" ]; then
    target_model=$(python3 -c "import sys, os; sys.path.insert(0, '${SCRIPT_DIR}'); import preflight; print(preflight.sanitize_served_name('${MODEL_ID}'))" 2>/dev/null || true)
  fi

  if [ -z "${target_model}" ]; then
    echo "ERROR: Unable to determine served model name. Ensure vLLM is running or set SERVED_MODEL_NAME." >&2
    return 1
  fi

  echo "Target Model Alias: ${target_model}"

  # Capability detection (text vs multimodal)
  local model_kind="${MODEL_KIND:-}"
  if [ -z "${model_kind}" ] && [ -n "${MODEL_ID:-}" ]; then
    model_kind=$(python3 -c "
import sys, os
sys.path.insert(0, '${SCRIPT_DIR}')
try:
    import preflight
    info, cfg = preflight.fetch_hf_model_metadata('${MODEL_ID}', os.environ.get('HF_TOKEN'))
    attrs = preflight.inspect_model_attributes(info, cfg)
    print(attrs.get('model_kind', 'text_causal_lm'))
except Exception:
    mid = '${MODEL_ID}'.lower()
    if any(k in mid for k in ['glm-ocr', 'ocr', 'vl', 'vision', 'multimodal']):
        print('multimodal_causal_lm')
    else:
        print('text_causal_lm')
" 2>/dev/null || echo "text_causal_lm")
  fi

  local payload
  if [ "${model_kind}" = "multimodal_causal_lm" ]; then
    echo "Detected Model Kind: ${model_kind}"
    echo "Generating deterministic OCR test image (RELAY GLM OCR TEST 123)..."
    local image_data_uri
    image_data_uri=$(python3 "${SCRIPT_DIR}/test_image.py")
    payload=$(python3 -c "
import json, sys
data_uri = sys.argv[1]
model = sys.argv[2]
req = {
    'model': model,
    'messages': [
        {
            'role': 'user',
            'content': [
                {'type': 'image_url', 'image_url': {'url': data_uri}},
                {'type': 'text', 'text': 'Text Recognition: Extract all text from this image.'}
            ]
        }
    ],
    'temperature': 0.0,
    'max_tokens': 64
}
print(json.dumps(req))
" "${image_data_uri}" "${target_model}")
  else
    echo "Detected Model Kind: text_causal_lm"
    payload=$(cat <<EOF
{
  "model": "${target_model}",
  "messages": [
    {"role": "user", "content": "Reply with only the single word PONG"}
  ],
  "temperature": 0.0,
  "max_tokens": 16
}
EOF
)
  fi

  echo "Sending test inference request to http://127.0.0.1:${PORT}/v1/chat/completions..."

  local start_time
  start_time=$(python3 -c "import time; print(time.time())")

  local res
  res=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST "http://127.0.0.1:${PORT}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "${payload}")

  local end_time
  end_time=$(python3 -c "import time; print(time.time())")
  local latency_ms
  latency_ms=$(python3 -c "import sys; s=float(sys.argv[1]); e=float(sys.argv[2]); print(f'{(e - s) * 1000:.1f}')" "${start_time}" "${end_time}" 2>/dev/null || echo "0.0")

  local http_code
  http_code=$(echo "${res}" | grep "HTTP_STATUS:" | cut -d":" -f2)
  local body
  body=$(echo "${res}" | grep -v "HTTP_STATUS:")

  if [ "${http_code}" -eq 200 ]; then
    echo "SUCCESS (HTTP 200) - Latency: ${latency_ms} ms"
    local preview
    preview=$(echo "${body}" | python3 -c "import sys, json; res=json.load(sys.stdin); print(res.get('choices', [{}])[0].get('message', {}).get('content', '').strip())" 2>/dev/null || echo "${body}")
    echo "Response Preview: ${preview}"
    if [ "${model_kind}" = "multimodal_causal_lm" ]; then
      echo "Multimodal OCR Validation:"
      python3 -c "
import sys
text = sys.argv[1].upper()
expected = ['RELAY', 'GLM', 'OCR', 'TEST', '123']
found = [t for t in expected if t in text]
print(f'  Matched {len(found)}/{len(expected)} expected tokens: {found}')
if len(found) >= 2:
    print('  OCR Smoke Test: PASSED')
else:
    print('  OCR Smoke Test: WARNING (Low token match, check preview)')
" "${preview}"
    fi
  else
    echo "FAILURE (HTTP ${http_code}) - Latency: ${latency_ms} ms" >&2
    echo "${body}" >&2
    return 1
  fi
}

stop_server() {
  echo "Stopping vLLM server..."
  if [ -f "${PID_FILE}" ]; then
    local pid
    pid=$(cat "${PID_FILE}" 2>/dev/null || true)
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
      echo "Sending SIGTERM to PID ${pid}..."
      kill "${pid}" 2>/dev/null || true
      for _ in {1..15}; do
        if ! kill -0 "${pid}" 2>/dev/null; then
          echo "Process ${pid} stopped cleanly."
          break
        fi
        sleep 1
      done
      if kill -0 "${pid}" 2>/dev/null; then
        echo "Process did not exit after 15s; sending SIGKILL..."
        kill -9 "${pid}" 2>/dev/null || true
      fi
    else
      echo "Process ${pid} was not running."
    fi
    rm -f "${PID_FILE}"
  else
    echo "No PID file found at ${PID_FILE}."
  fi

  clean_stale
  echo "Stop operation complete."
}

show_logs() {
  local lines="${2:-100}"
  if [ -f "${LOG_FILE}" ]; then
    tail -n "${lines}" "${LOG_FILE}"
  else
    echo "Log file ${LOG_FILE} does not exist yet."
  fi
}

case "${1:-status}" in
  check)
    check_env
    ;;
  preflight)
    run_preflight
    ;;
  clean)
    clean_stale
    ;;
  start)
    start_server
    ;;
  status)
    status_server
    ;;
  test)
    test_inference
    ;;
  stop)
    stop_server
    ;;
  logs)
    show_logs "${@}"
    ;;
  *)
    echo "Usage: $0 {check|preflight|clean|start|status|test|logs [N]|stop}"
    exit 1
    ;;
esac
