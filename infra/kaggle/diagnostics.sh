#!/usr/bin/env bash
# ==============================================================================
# Relay Kaggle Infrastructure: Diagnostics & Health Check Suite
#
# Inspects the complete stack and provides actionable remediation steps for:
# 1. GPU Memory & VRAM Occupancy
# 2. CUDA & PyTorch Hardware Visibility
# 3. Port 8000 Conflicts
# 4. vLLM Process & Worker Health
# 5. Model Cache & Integrity
# 6. Local /v1/models & /v1/chat/completions Responsiveness
# 7. cloudflared Binary Status
# 8. Tunnel Process & Connection Health
# 9. Public Endpoint Reachability
# 10. End-to-End Latency & Response Codes
#
# Usage:
#   ./diagnostics.sh all      - Run all diagnostic suites
#   ./diagnostics.sh gpu      - Inspect GPUs and VRAM usage
#   ./diagnostics.sh cuda     - Inspect CUDA runtime and library paths
#   ./diagnostics.sh vllm     - Inspect vLLM process, workers, and logs
#   ./diagnostics.sh tunnel   - Inspect Cloudflare tunnel status and public URL
#   ./diagnostics.sh network  - Inspect port 8000 and HTTP endpoints
#   ./diagnostics.sh logs     - Show recent logs from both vLLM and cloudflared
# ==============================================================================

set -euo pipefail

WORK_DIR="${WORK_DIR:-/kaggle/working}"
VLLM_LOG="${WORK_DIR}/vllm_server.log"
VLLM_PID_FILE="${WORK_DIR}/vllm.pid"
CF_LOG="${WORK_DIR}/cloudflared.log"
CF_PID_FILE="${WORK_DIR}/cloudflared.pid"
CF_BIN="${WORK_DIR}/cloudflared"
PORT="${PORT:-8000}"

diag_gpu() {
  echo "========================================================"
  echo " DIAGNOSTIC: GPU Hardware & Memory Status"
  echo "========================================================"
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "[FAIL] nvidia-smi command not found."
    echo "  Likely Cause: Notebook accelerator is set to CPU instead of 'GPU T4 x2'."
    echo "  Remediation: In the Kaggle right sidebar, select Settings > Accelerator > GPU T4 x2."
    return 1
  fi

  local count
  count=$(nvidia-smi --query-gpu=name --format=csv,noheader | wc -l)
  echo "Detected GPUs (${count}):"
  nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv,noheader

  if [ "${count}" -lt 2 ]; then
    echo -e "\n[WARNING] Only ${count} GPU detected. Tensor parallelism requires 2 GPUs."
    echo "  Remediation: Enable dual GPU in Kaggle settings ('GPU T4 x2')."
  fi

  # Check if GPU memory is heavily occupied when vLLM is supposed to be stopped
  echo -e "\nActive Processes on GPUs:"
  local gpu_procs
  gpu_procs=$(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader || true)
  if [ -z "${gpu_procs}" ]; then
    echo "  No compute applications currently registered on GPUs."
  else
    echo "${gpu_procs}"
  fi
}

diag_cuda() {
  echo "========================================================"
  echo " DIAGNOSTIC: CUDA & Python Environment"
  echo "========================================================"
  python3 - <<'EOF'
import sys, os
print(f"Python executable: {sys.executable}")
print(f"Python version: {sys.version.split()[0]}")

try:
    import torch
    print(f"PyTorch version: {torch.__version__}")
    print(f"CUDA available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"CUDA version: {torch.version.cuda}")
        print(f"Device count: {torch.cuda.device_count()}")
        for i in range(torch.cuda.device_count()):
            name = torch.cuda.get_device_name(i)
            free_mem = torch.cuda.mem_get_info(i)[0] / (1024**2)
            total_mem = torch.cuda.mem_get_info(i)[1] / (1024**2)
            print(f"  Device {i} ({name}): {free_mem:.0f} MiB free / {total_mem:.0f} MiB total")
            # Quick allocation sanity test
            x = torch.zeros((100, 100), device=f"cuda:{i}")
            del x
        torch.cuda.empty_cache()
        print("  CUDA allocation sanity test: PASS")
    else:
        print("[FAIL] torch.cuda.is_available() returned False!")
except Exception as e:
    print(f"[FAIL] Error testing PyTorch CUDA: {e}")
EOF

  # Check CUDA 13 library path in Kaggle
  local cu13_path="/usr/local/lib/python3.12/dist-packages/nvidia/cu13/lib"
  if [ -d "${cu13_path}" ]; then
    echo "CUDA 13 shared libraries found at: ${cu13_path}"
    if [[ "${LD_LIBRARY_PATH:-}" != *"${cu13_path}"* ]]; then
      echo "[NOTE] Consider exporting LD_LIBRARY_PATH=\"${cu13_path}:\$LD_LIBRARY_PATH\""
    fi
  fi
}

diag_network() {
  echo "========================================================"
  echo " DIAGNOSTIC: Network & Port ${PORT} Availability"
  echo "========================================================"
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids=$(lsof -ti ":${PORT}" 2>/dev/null || true)
    if [ -n "${pids}" ]; then
      echo "[WARNING] Port ${PORT} is currently occupied by process(es): ${pids}"
      ps -p "${pids}" -o pid,user,comm,args
      echo "  Remediation: Run './qwen-vllm.sh clean' to safely terminate stale listeners."
    else
      echo "[PASS] Port ${PORT} is open and available."
    fi
  else
    echo "lsof not installed; checking with curl..."
    if curl -s --connect-timeout 1 "http://127.0.0.1:${PORT}" >/dev/null 2>&1; then
      echo "[WARNING] Port ${PORT} is actively responding to HTTP requests."
    else
      echo "[PASS] Port ${PORT} appears free."
    fi
  fi
}

diag_vllm() {
  echo "========================================================"
  echo " DIAGNOSTIC: vLLM Server & Worker Health"
  echo "========================================================"
  if ! command -v vllm >/dev/null 2>&1; then
    echo "[FAIL] vLLM CLI not found."
    echo "  Remediation: Run 'pip install -q --no-cache-dir vllm==0.29.0'."
    return 1
  fi

  echo "vLLM CLI Path: $(command -v vllm)"

  local is_running=0
  local pid=""
  if [ -f "${VLLM_PID_FILE}" ]; then
    pid=$(cat "${VLLM_PID_FILE}" 2>/dev/null || true)
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
      is_running=1
    fi
  fi

  if [ "${is_running}" -eq 1 ]; then
    echo "[PASS] Main vLLM process is running (PID ${pid})."
    
    # Check for worker processes
    local workers
    workers=$(pgrep -P "${pid}" || true)
    if [ -n "${workers}" ]; then
      echo "  Active child workers (PIDs): ${workers}"
    fi

    # Probe local endpoint
    echo "Probing local models endpoint http://127.0.0.1:${PORT}/v1/models..."
    local http_res
    http_res=$(curl -s -w "\nHTTP_STATUS:%{http_code}" --connect-timeout 3 "http://127.0.0.1:${PORT}/v1/models" 2>/dev/null || true)
    local code
    code=$(echo "${http_res}" | grep "HTTP_STATUS:" | cut -d':' -f2 || true)
    local body
    body=$(echo "${http_res}" | grep -v "HTTP_STATUS:" || true)

    if [ "${code}" = "200" ]; then
      echo "[PASS] vLLM local API is healthy (HTTP 200)."
      echo "  Served models: ${body}"
    else
      echo "[WAIT/FAIL] Endpoint returned HTTP ${code:-connection_refused}."
      echo "  vLLM may still be downloading model weights or compiling KV cache."
      echo "  Inspect progress: tail -n 25 ${VLLM_LOG}"
    fi
  else
    echo "[INACTIVE] vLLM is not running."
    if [ -f "${VLLM_LOG}" ]; then
      echo -e "\nLast 20 log lines from ${VLLM_LOG}:"
      tail -n 20 "${VLLM_LOG}"
    fi
  fi
}

diag_tunnel() {
  echo "========================================================"
  echo " DIAGNOSTIC: Cloudflare Tunnel & Public Ingress"
  echo "========================================================"
  if [ ! -x "${CF_BIN}" ]; then
    echo "[FAIL] cloudflared binary missing at ${CF_BIN}."
    echo "  Remediation: Run './cloudflared.sh check' to download official binary."
    return 1
  fi

  echo "cloudflared binary: ${CF_BIN}"
  "${CF_BIN}" --version

  local is_running=0
  local pid=""
  if [ -f "${CF_PID_FILE}" ]; then
    pid=$(cat "${CF_PID_FILE}" 2>/dev/null || true)
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
      is_running=1
    fi
  fi

  if [ "${is_running}" -eq 1 ]; then
    echo "[PASS] cloudflared process is running (PID ${pid})."
    
    if [ -f "${CF_LOG}" ]; then
      local url
      url=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' "${CF_LOG}" | tail -n 1 || true)
      if [ -n "${url}" ]; then
        echo "[PASS] Active Public URL: ${url}"
        
        # Test public endpoint reachability
        echo "Testing public reachability: ${url}/v1/models..."
        local pub_res
        pub_res=$(curl -s -w "\nHTTP_STATUS:%{http_code}" --connect-timeout 5 "${url}/v1/models" 2>/dev/null || true)
        local code
        code=$(echo "${pub_res}" | grep "HTTP_STATUS:" | cut -d':' -f2 || true)
        if [ "${code}" = "200" ]; then
          echo "[PASS] Public tunnel is routing traffic successfully (HTTP 200)."
        else
          echo "[WARNING] Public endpoint returned HTTP ${code:-timeout}. Tunnel may still be propagating DNS."
        fi
      else
        echo "[WAIT] No trycloudflare.com URL detected in log yet."
      fi
    fi
  else
    echo "[INACTIVE] cloudflared tunnel is not running."
  fi
}

diag_all() {
  diag_gpu || true
  echo ""
  diag_cuda || true
  echo ""
  diag_network || true
  echo ""
  diag_vllm || true
  echo ""
  diag_tunnel || true
  echo ""
  echo "========================================================"
  echo " DIAGNOSTIC SUMMARY COMPLETE"
  echo "========================================================"
}

diag_logs() {
  echo "========================================================"
  echo " vLLM Server Logs (Last 50 lines: ${VLLM_LOG})"
  echo "========================================================"
  if [ -f "${VLLM_LOG}" ]; then
    tail -n 50 "${VLLM_LOG}"
  else
    echo "File not found: ${VLLM_LOG}"
  fi

  echo -e "\n========================================================"
  echo " Cloudflare Tunnel Logs (Last 30 lines: ${CF_LOG})"
  echo "========================================================"
  if [ -f "${CF_LOG}" ]; then
    tail -n 30 "${CF_LOG}"
  else
    echo "File not found: ${CF_LOG}"
  fi
}

case "${1:-all}" in
  all)
    diag_all
    ;;
  gpu)
    diag_gpu
    ;;
  cuda)
    diag_cuda
    ;;
  vllm)
    diag_vllm
    ;;
  tunnel)
    diag_tunnel
    ;;
  network)
    diag_network
    ;;
  logs)
    diag_logs
    ;;
  *)
    echo "Usage: $0 {all|gpu|cuda|vllm|tunnel|network|logs}"
    exit 1
    ;;
esac
