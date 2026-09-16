# Relay Kaggle Infrastructure Scripts

This directory contains production-tested, reproducible management scripts for deploying the self-hosted **Qwen3-Coder-30B-A3B-Instruct** model via **vLLM** on a Kaggle dual NVIDIA Tesla T4 GPU environment and exposing it securely to Relay over a Cloudflare Quick Tunnel.

---

## Script Index

| Script               | Purpose                                                                                        | Key Subcommands                                             |
| :------------------- | :--------------------------------------------------------------------------------------------- | :---------------------------------------------------------- |
| **`qwen-vllm.sh`**   | Manages vLLM background process lifecycle, health polling, local inference, and safe cleanup.  | `check`, `clean`, `start`, `status`, `test`, `logs`, `stop` |
| **`cloudflared.sh`** | Manages `cloudflared` binary download, background tunnel execution, and dynamic URL discovery. | `check`, `start`, `status`, `url`, `logs`, `stop`           |
| **`diagnostics.sh`** | Comprehensive 10-point system, GPU, CUDA, process, network, and tunnel diagnostic suite.       | `all`, `gpu`, `cuda`, `vllm`, `tunnel`, `network`, `logs`   |

---

## How the Scripts Get into Kaggle

These scripts live in the canonical Relay GitHub repository. **They are not manually created or uploaded to Kaggle.**

When running in a Kaggle session, pull the scripts by cloning the repository into `/kaggle/working/Relay`:

```bash
# 1. Clone the Relay repository
git clone https://github.com/mosabbir-maruf/Relay.git /kaggle/working/Relay

# 2. Change into the repository directory
cd /kaggle/working/Relay

# 3. Grant execute permissions to the scripts
chmod +x infra/kaggle/*.sh
```

### Why `chmod +x` is Required

Git tracks standard file contents and modes, but depending on how repositories are cloned or mounted within Kaggle's containerized filesystem, POSIX execute bits (`+x`) must be explicitly applied before invoking `./infra/kaggle/<script>.sh` directly from bash or Jupyter cells.

---

## Recommended Execution Sequence

Run all commands from `/kaggle/working/Relay`:

```bash
# Step 1: Preflight check (GPUs, vLLM CLI, port 8000)
./infra/kaggle/qwen-vllm.sh check

# Step 2: Full diagnostic sweep (detects existing sessions or port conflicts)
./infra/kaggle/diagnostics.sh all

# Step 3: Clean up any stale listeners on port 8000
./infra/kaggle/qwen-vllm.sh clean

# Step 4: Launch vLLM in background (TP=2, FP16, AWQ, eager execution)
./infra/kaggle/qwen-vllm.sh start

# Step 5: Check server readiness (takes ~2-3 min for weight loading & KV cache)
./infra/kaggle/qwen-vllm.sh status

# Step 6: Smoke test local inference (sends "PONG" prompt)
./infra/kaggle/qwen-vllm.sh test

# Step 7: Verify or auto-download cloudflared binary
./infra/kaggle/cloudflared.sh check

# Step 8: Start Cloudflare Quick Tunnel and display the dynamic public URL
./infra/kaggle/cloudflared.sh start

# Step 9: Inspect full status
./infra/kaggle/diagnostics.sh tunnel

# Step 10: Clean shutdown when finished
./infra/kaggle/cloudflared.sh stop
./infra/kaggle/qwen-vllm.sh stop
```

---

## Verified Configuration

The scripts implement the exact configuration verified on Kaggle dual NVIDIA Tesla T4 GPUs:

```bash
MODEL_ID="QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ"
SERVED_MODEL_NAME="qwen3-coder-30b"
TENSOR_PARALLEL_SIZE="2"
DTYPE="float16"
QUANTIZATION="awq"
MAX_MODEL_LEN="4096"
MAX_NUM_SEQS="4"
GPU_MEMORY_UTILIZATION="0.85"
HOST="0.0.0.0"
PORT="8000"
```

### Key Design Rationale

- **`vllm serve`**: Canonical CLI entrypoint. (Never use obsolete `vllm server`).
- **Single Served Name**: `--served-model-name qwen3-coder-30b`. Comma-separated names are parsed by vLLM as a single literal compound string.
- **No `--swap-space`**: This flag is unsupported in vLLM 0.29.0 on Kaggle and must be omitted.
- **CUDA 13 Path**: Automatically prepends `/usr/local/lib/python3.12/dist-packages/nvidia/cu13/lib` to `LD_LIBRARY_PATH` to resolve `libcudart.so.13` dependencies.

---

## Process Isolation & Log Locations

Processes run as daemons via `nohup` so they never block the calling terminal or Jupyter notebook cells.

- **vLLM PID**: `/kaggle/working/vllm.pid`
- **vLLM Server Logs**: `/kaggle/working/vllm_server.log`
- **Cloudflare PID**: `/kaggle/working/cloudflared.pid`
- **Cloudflare Tunnel Logs**: `/kaggle/working/cloudflared.log`
- **Cloudflared Binary**: `/kaggle/working/cloudflared`

Because `WORK_DIR` defaults to `/kaggle/working`, all operational logs and PIDs are kept outside `/kaggle/working/Relay`, keeping the git working tree clean.

---

## Troubleshooting Quick Reference

| Issue                     | Diagnostic / Remediation                                                                |
| :------------------------ | :-------------------------------------------------------------------------------------- |
| **GPU out of memory**     | Run `./infra/kaggle/qwen-vllm.sh clean` then check `nvidia-smi`.                        |
| **Port 8000 occupied**    | Run `./infra/kaggle/qwen-vllm.sh clean`.                                                |
| **Weights still loading** | Run `./infra/kaggle/qwen-vllm.sh logs 50` or `tail -f /kaggle/working/vllm_server.log`. |
| **Tunnel URL missing**    | Run `./infra/kaggle/cloudflared.sh logs 30`.                                            |
| **Full Stack Health**     | Run `./infra/kaggle/diagnostics.sh all`.                                                |
