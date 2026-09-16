# Relay Kaggle Infrastructure Scripts

This directory contains standalone, reproducible management scripts for deploying the self-hosted **Qwen3-Coder-30B-A3B-Instruct** model via **vLLM** on Kaggle dual NVIDIA Tesla T4 GPUs and exposing it securely to Relay over a Cloudflare Quick Tunnel.

---

## Script Index

| Script               | Purpose                                                                                                       | Key Subcommands                                             |
| :------------------- | :------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------- |
| **`qwen-vllm.sh`**   | Manages vLLM server background lifecycle, health polling, inference tests, and safe cleanup.                  | `check`, `start`, `status`, `test`, `clean`, `logs`, `stop` |
| **`cloudflared.sh`** | Manages official `cloudflared` binary download, background tunnel execution, and dynamic URL extraction.      | `check`, `start`, `status`, `url`, `logs`, `stop`           |
| **`diagnostics.sh`** | Comprehensive 10-point system, GPU, CUDA, process, network, and tunnel diagnostics with remediation guidance. | `all`, `gpu`, `cuda`, `vllm`, `tunnel`, `network`, `logs`   |

---

## Quick Start (Terminal / Bash Cell)

```bash
# 1. Check prerequisites and GPUs
./qwen-vllm.sh check

# 2. Clean up any stale workers from earlier failed runs
./qwen-vllm.sh clean

# 3. Start vLLM in the background
./qwen-vllm.sh start

# 4. Check status until online (typically ~2-3 minutes for model weights & KV cache)
./qwen-vllm.sh status

# 5. Run a local inference test
./qwen-vllm.sh test

# 6. Start Cloudflare Tunnel and display public URL
./cloudflared.sh start

# 7. Run diagnostics anytime to verify all components
./diagnostics.sh all

# 8. Safely shutdown when finished
./cloudflared.sh stop
./qwen-vllm.sh stop
```

---

## Verified Configuration

The scripts use the configuration verified on Kaggle dual NVIDIA Tesla T4 GPUs:

```bash
MODEL_ID="QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ"
SERVED_MODEL_NAME="qwen3-coder-30b"
TENSOR_PARALLEL_SIZE="2"
DTYPE="float16"
QUANTIZATION="awq"
MAX_MODEL_LEN="4096"
MAX_NUM_SEQS="4"
GPU_MEMORY_UTILIZATION="0.85"
PORT="8000"
```

All environment variables can be overridden at invocation, e.g.:

```bash
MAX_MODEL_LEN=8192 ./qwen-vllm.sh start
```

---

## Log Locations

- vLLM Server: `/kaggle/working/vllm_server.log`
- Cloudflare Tunnel: `/kaggle/working/cloudflared.log`
