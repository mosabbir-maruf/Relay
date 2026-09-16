#!/usr/bin/env bash
# ==============================================================================
# Relay Kaggle Infrastructure: Qwen/vLLM Server Management
#
# Manages the lifecycle of the self-hosted Qwen vLLM backend on dual NVIDIA T4s.
# Usage:
#   ./qwen-vllm.sh check   - Check prerequisites, GPUs, and port availability
#   ./qwen-vllm.sh clean   - Safely clean up stale vLLM processes on port 8000
#   ./qwen-vllm.sh start   - Launch vLLM in the background
#   ./qwen-vllm.sh status  - Check process status and endpoint readiness
#   ./qwen-vllm.sh test    - Run a local inference test (PONG prompt)
#   ./qwen-vllm.sh logs    - View the latest server logs
#   ./qwen-vllm.sh stop    - Safely terminate vLLM and verify GPU memory release
# ==============================================================================

set -euo pipefail

MODEL_ID="${MODEL_ID:-QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ}"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-qwen3-coder-30b}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
TENSOR_PARALLEL_SIZE="${TENSOR_PARALLEL_SIZE:-2}"
DTYPE="${DTYPE:-float16}"
QUANTIZATION="${QUANTIZATION:-awq}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-4096}"
MAX_NUM_SEQS="${MAX_NUM_SEQS:-4}"
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.85}"

WORK_DIR="${WORK_DIR:-/kaggle/working}"
LOG_FILE="${WORK_DIR}/vllm_server.log"
PID_FILE="${WORK_DIR}/vllm.pid"

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

  gpu_count=$(nvidia-smi --query-gpu=name --format=csv,noheader | wc -l)
  echo "Detected ${gpu_count} GPU(s):"
  nvidia-smi --query-gpu=index,name,memory.total,memory.free --format=csv,noheader

  if [ "${gpu_count}" -lt "${TENSOR_PARALLEL_SIZE}" ]; then
    echo "WARNING: Detected ${gpu_count} GPU(s), but tensor-parallel-size is ${TENSOR_PARALLEL_SIZE}." >&2
  fi

  echo -e "\n=== [2/3] Checking vLLM Installation ==="
  if command -v vllm >/dev/null 2>&1; then
    echo "vLLM CLI available: $(command -v vllm)"
    vllm --version || true
  else
    echo "ERROR: 'vllm' binary not found on PATH." >&2
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
        # Confirm process name contains python or vllm before killing
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
      echo "Use './qwen-vllm.sh status' to inspect, or './qwen-vllm.sh stop' before restarting." >&2
      return 1
    fi
  fi

  # Check if port 8000 is occupied
  if command -v lsof >/dev/null 2>&1 && lsof -i ":${PORT}" >/dev/null 2>&1; then
    echo "ERROR: Port ${PORT} is already occupied. Run './qwen-vllm.sh clean' first." >&2
    return 1
  fi

  mkdir -p "${WORK_DIR}"
  echo "Launching vLLM in background..."
  echo "Model: ${MODEL_ID}"
  echo "Served name: ${SERVED_MODEL_NAME}"
  echo "Log file: ${LOG_FILE}"

  nohup vllm serve "${MODEL_ID}" \
    --served-model-name "${SERVED_MODEL_NAME}" \
    --host "${HOST}" \
    --port "${PORT}" \
    --tensor-parallel-size "${TENSOR_PARALLEL_SIZE}" \
    --dtype "${DTYPE}" \
    --quantization "${QUANTIZATION}" \
    --max-model-len "${MAX_MODEL_LEN}" \
    --max-num-seqs "${MAX_NUM_SEQS}" \
    --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION}" \
    --enforce-eager \
    --trust-remote-code \
    > "${LOG_FILE}" 2>&1 &

  local server_pid=$!
  echo "${server_pid}" > "${PID_FILE}"
  echo "vLLM process launched with PID: ${server_pid}"

  echo "Waiting for initial process confirmation..."
  sleep 3
  if ! kill -0 "${server_pid}" 2>/dev/null; then
    echo "ERROR: vLLM process exited immediately! Showing last 30 log lines:" >&2
    tail -n 30 "${LOG_FILE}" >&2
    rm -f "${PID_FILE}"
    return 1
  fi

  echo "vLLM is running. Run './qwen-vllm.sh status' or follow logs: tail -f ${LOG_FILE}"
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
  echo "Sending test inference request to http://127.0.0.1:${PORT}/v1/chat/completions..."

  local payload
  payload=$(cat <<EOF
{
  "model": "${SERVED_MODEL_NAME}",
  "messages": [
    {"role": "user", "content": "Reply with only the single word PONG"}
  ],
  "temperature": 0.0,
  "max_tokens": 16
}
EOF
)

  local res
  res=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST "http://127.0.0.1:${PORT}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "${payload}")

  local http_code
  http_code=$(echo "${res}" | grep "HTTP_STATUS:" | cut -d':' -f2)
  local body
  body=$(echo "${res}" | grep -v "HTTP_STATUS:")

  if [ "${http_code}" -eq 200 ]; then
    echo "SUCCESS (HTTP 200)"
    echo "Response payload:"
    echo "${body}"
  else
    echo "FAILURE (HTTP ${http_code})" >&2
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
      for i in {1..15}; do
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
    echo "Usage: $0 {check|clean|start|status|test|logs [lines]|stop}"
    exit 1
    ;;
esac
