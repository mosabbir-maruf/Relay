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

When running in a Kaggle/Jupyter session, remember that notebook **Code** cells execute Python by default. The commands below are **Bash/shell commands**, so run them in a cell prefixed with `%%bash`.

### Clone the repository

```bash
%%bash
set -e

if [ -d /kaggle/working/Relay/.git ]; then
  echo "Relay repository already exists. Skipping clone."
else
  git clone https://github.com/mosabbir-maruf/Relay.git /kaggle/working/Relay
fi

cd /kaggle/working/Relay
chmod +x infra/kaggle/*.sh

echo "Relay Kaggle scripts are ready."
```

> **Important:** Do not paste `git clone`, `cd`, or `chmod` directly into a normal Python Code cell. Doing so will result in a Python `SyntaxError`.

For a single shell command, Kaggle also supports the `!` prefix, for example:

```python
!nvidia-smi
```

For multiple related shell commands, prefer `%%bash` because the entire cell then runs in one Bash process.

### Why `chmod +x` is Required

Git tracks standard file contents and modes, but depending on how repositories are cloned or mounted within Kaggle's containerized filesystem, POSIX execute bits (`+x`) must be explicitly applied before invoking `./infra/kaggle/<script>.sh` directly from bash or Jupyter cells.

---

## Kaggle Prerequisites

Before running the Relay infrastructure checks, make sure the Kaggle Notebook has a **GPU accelerator enabled** and **Internet access enabled**. The current Qwen deployment scripts target **dual NVIDIA Tesla T4 GPUs**.

### Install vLLM

The `qwen-vllm.sh` script expects the `vllm` CLI to already be installed. Install the version used by the verified Kaggle configuration:

```python
!python -m pip install -q --no-cache-dir "vllm==0.29.0"
```

Then verify the installation:

```python
!vllm --version
```

Expected output:

```text
0.29.0
```

> **Why this step matters:** `qwen-vllm.sh check` intentionally fails when the `vllm` binary is missing instead of silently installing dependencies. Keeping installation separate makes the runtime check predictable and makes failures easier to diagnose.

---

## Recommended Execution Sequence

Run each group below in a **separate Kaggle Code cell**. Each shell-command cell starts with `%%bash` unless noted otherwise.

### 1. Preflight check

```bash
%%bash
cd /kaggle/working/Relay
./infra/kaggle/qwen-vllm.sh check
```

Checks the GPU environment, vLLM CLI, and port 8000 before starting anything.

### 2. Full diagnostic sweep

```bash
%%bash
cd /kaggle/working/Relay
./infra/kaggle/diagnostics.sh all
```

Detects existing processes, port conflicts, CUDA/GPU issues, networking state, and tunnel state.

### 3. Clean up stale listeners

```bash
%%bash
cd /kaggle/working/Relay
./infra/kaggle/qwen-vllm.sh clean
```

### 4. Launch vLLM

```bash
%%bash
cd /kaggle/working/Relay
./infra/kaggle/qwen-vllm.sh start
```

The script starts vLLM in the background using tensor parallelism across the two T4 GPUs.

### 5. Check server readiness

```bash
%%bash
cd /kaggle/working/Relay
./infra/kaggle/qwen-vllm.sh status
```

Weight loading and KV-cache initialization may take a few minutes.

### 6. Smoke test local inference

```bash
%%bash
cd /kaggle/working/Relay
./infra/kaggle/qwen-vllm.sh test
```

This verifies that the local OpenAI-compatible endpoint can actually generate a response.

### 7. Verify `cloudflared`

```bash
%%bash
cd /kaggle/working/Relay
./infra/kaggle/cloudflared.sh check
```

### 8. Start the Cloudflare Quick Tunnel

```bash
%%bash
cd /kaggle/working/Relay
./infra/kaggle/cloudflared.sh start
```

The command starts the tunnel in the background and exposes the local API through a temporary public URL.

### 9. Inspect tunnel diagnostics

```bash
%%bash
cd /kaggle/working/Relay
./infra/kaggle/diagnostics.sh tunnel
```

### 10. Clean shutdown

Run these when you are finished with the Kaggle session:

```bash
%%bash
cd /kaggle/working/Relay
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

| Issue                              | Diagnostic / Remediation                                                                      |
| :--------------------------------- | :-------------------------------------------------------------------------------------------- |
| **`vllm` not found**               | Run the `Install vLLM` prerequisite above, then verify with `!vllm --version`.                |
| **GPU out of memory**              | Run `./infra/kaggle/qwen-vllm.sh clean` then check `nvidia-smi`.                               |
| **Port 8000 occupied**             | Run `./infra/kaggle/qwen-vllm.sh clean`.                                                       |
| **Weights still loading**          | Run `./infra/kaggle/qwen-vllm.sh logs 50` or `tail -f /kaggle/working/vllm_server.log`.       |
| **Tunnel URL missing**             | Run `./infra/kaggle/cloudflared.sh logs 30`.                                                   |
| **Full Stack Health**              | Run `./infra/kaggle/diagnostics.sh all`.                                                       |
| **Python `SyntaxError` in Kaggle** | Ensure Bash commands are inside a `%%bash` cell instead of a normal Python cell.              |
