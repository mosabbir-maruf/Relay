# Relay Kaggle Infrastructure Scripts

This directory contains production-tested, reproducible management scripts for deploying self-hosted LLM backends via **vLLM** on a Kaggle dual NVIDIA Tesla T4 GPU environment and exposing them securely to Relay over a Cloudflare Quick Tunnel.

Two deployment workflows are supported:

1. **Generic Hugging Face Deployment (`vllm.sh` + `preflight.py`)**: A model-agnostic, parameter-driven system capable of inspecting any compatible Hugging Face model, resolving hardware-safe execution parameters for dual Tesla T4s, and managing the server lifecycle.
2. **Qwen Reference Deployment (`qwen-vllm.sh`)**: The stable, turn-key reference configuration for `QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ`.

---

## Script Index

| Script               | Purpose                                                                                           | Key Subcommands                                                                                                                                |
| :------------------- | :------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------- |
| **`vllm.sh`**        | Generic vLLM lifecycle manager driven by environment variables and preflight resolution.          | `check`, `preflight`, `clean`, `start`, `status`, `test`, `logs [N]`, `stop`                                                                   |
| **`preflight.py`**   | Hugging Face Hub inspector and memory-aware candidate recommendation engine (Python 3.8+ stdlib). | `--model-id`, `--tensor-parallel-size`, `--max-model-len`, `--max-num-seqs`, `--gpu-memory-utilization`, `--dtype`, `--quantization`, `--json` |
| **`test_image.py`**  | Pure standard library PNG generator and base64 data URI encoder for multimodal OCR smoke tests.   | `[text]` (prints `data:image/png;base64,...`)                                                                                                  |
| **`qwen-vllm.sh`**   | Dedicated reference manager for Qwen3-Coder-30B-AWQ.                                              | `check`, `clean`, `start`, `status`, `test`, `logs [N]`, `stop`                                                                                |
| **`cloudflared.sh`** | Manages `cloudflared` binary download, background tunnel execution, and dynamic URL discovery.    | `check`, `start`, `status`, `url`, `logs [N]`, `stop`                                                                                          |
| **`diagnostics.sh`** | Comprehensive 10-point system, GPU, CUDA, process, network, and tunnel diagnostic suite.          | `all`, `gpu`, `cuda`, `vllm`, `tunnel`, `network`, `logs`                                                                                      |

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

Before running the Relay infrastructure checks, make sure the Kaggle Notebook has a **GPU accelerator enabled** and **Internet access enabled**.

### Install vLLM

Both workflows expect the `vllm` CLI to already be installed. Install the verified version:

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

> **Why this step matters:** `vllm.sh check` and `qwen-vllm.sh check` intentionally fail when the `vllm` binary is missing instead of silently installing unpinned dependencies. Keeping installation separate makes runtime checks predictable and failures easier to diagnose.

---

## Workflow 1: Generic Hugging Face Model Deployment

The generic workflow allows you to deploy any compatible causal language model or multimodal vision/OCR model simply by setting `MODEL_ID`. All deployment parameters default to automatic recommendation:

```bash
%%bash
cd /kaggle/working/Relay
export MODEL_ID="Qwen/Qwen2.5-Coder-7B-Instruct"

# Optional deployment overrides (leave unset for automatic recommendation):
# export TENSOR_PARALLEL_SIZE=""
# export MAX_MODEL_LEN=""
# export MAX_NUM_SEQS=""
# export GPU_MEMORY_UTILIZATION=""
# export DTYPE=""
# export QUANTIZATION=""
# export TRUST_REMOTE_CODE=""
# export EXTRA_VLLM_ARGS=""

# To deploy GLM-OCR instead:
# export MODEL_ID="zai-org/GLM-OCR"

# 1. Preflight validation & automatic candidate recommendation
./infra/kaggle/vllm.sh preflight

# 2. Cleanup stale listeners
./infra/kaggle/vllm.sh clean

# 3. Launch server in background
./infra/kaggle/vllm.sh start

# 4. Check readiness
./infra/kaggle/vllm.sh status

# 5. Smoke test local inference (automatically sends OCR image prompt for multimodal models)
./infra/kaggle/vllm.sh test

# 6. Expose over Cloudflare Quick Tunnel
./infra/kaggle/cloudflared.sh start
```

### Memory-Aware Recommendation Engine & Hardware Policy

The preflight engine (`preflight.py`) inspects model metadata via the Hugging Face Hub API and calculates a hardware-safe deployment candidate across 7 stages:

1. **Model Discovery**: Reads native parameter count, native context length, native dtype, architecture, attention dimensions (layers, heads, kv_heads, head_dim), and vision configuration.
2. **Serving Context Selection**: Distinguishes native context from serving context; bounds candidate context to $\min(\text{native\_context}, 4096)$ for text models ($\ge 512$ for multimodal).
3. **Component-wise Memory Breakdown**: Estimates individual components with explicit source and confidence tracking:
   - $M_{\text{weights}}$: bytes per parameter based on precision/quantization.
   - $M_{\text{visual}}$: derived from vision config or conservative heuristic (~1.0 GB) with warning.
   - $M_{\text{kv}}$: calculated from transformer attention dimensions ($2 \times \text{layers} \times \text{kv\_heads} \times \text{head\_dim} \times \text{bytes} \times \text{context} \times \text{seqs}$) or heuristic if dimensions are absent.
   - $M_{\text{cuda\_runtime}}$: fixed 1.0 GB headroom reserve per GPU.
4. **Candidate TP Evaluation**:
   - Computes single-GPU footprint: $M_{\text{weights}} + M_{\text{visual}} + M_{\text{cuda}} + M_{\text{kv}}$. If $\le 85\%$ of single-GPU VRAM, selects `TP=1`.
   - If single GPU is insufficient and 2 GPUs are present, evaluates `TP=2` (visual encoder replicated, KV cache sharded if $\text{kv\_heads} \ge 2$). If $\le 92\%$ per-GPU VRAM, selects `TP=2`.
   - If hardware has no GPU, reports `UNKNOWN_NO_GPU` and evaluates against the reference dual Tesla T4 profile (15.0 GB per GPU).
5. **Dynamic Utilization Calculation**: Computes target memory fraction from required per-GPU memory, then clamps to deployment policy bounds `[0.70, 0.92]`. Both raw and clamped values are exposed.
6. **Architecture & vLLM Version Registry**: Verifies architecture against a registry of known minimum vLLM versions. Reports `UNKNOWN` and requests runtime validation for unlisted architectures.
7. **T4 Precision Enforcement**: Coerces precision to `float16` for Tesla T4 (CC 7.5 lacks BF16 and FP8 hardware). Emits runtime stability warning for BF16-trained weights.
8. **Explainable Diagnostics**: Every recommendation decision exposes `{value, source, rationale, confidence, warning}` and marks preflight status as `CANDIDATE_RECOMMENDED` with startup monitoring advice.

---

## Workflow 2: Qwen3-Coder Reference Deployment

The Qwen reference workflow provides a fixed, pre-tested configuration for `QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ`:

```bash
%%bash
cd /kaggle/working/Relay

# 1. Hardware & port check
./infra/kaggle/qwen-vllm.sh check

# 2. Cleanup stale listeners
./infra/kaggle/qwen-vllm.sh clean

# 3. Launch Qwen vLLM server
./infra/kaggle/qwen-vllm.sh start

# 4. Check readiness
./infra/kaggle/qwen-vllm.sh status

# 5. Local inference test
./infra/kaggle/qwen-vllm.sh test

# 6. Expose over Cloudflare Quick Tunnel
./infra/kaggle/cloudflared.sh start
```

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

## Clean Shutdown

Run these when you are finished with the Kaggle session to free GPU memory:

```bash
%%bash
cd /kaggle/working/Relay
./infra/kaggle/cloudflared.sh stop
./infra/kaggle/vllm.sh stop
```

---

## Troubleshooting Quick Reference

| Issue                              | Diagnostic / Remediation                                                                |
| :--------------------------------- | :-------------------------------------------------------------------------------------- |
| **`vllm` not found**               | Run `!python -m pip install -q --no-cache-dir "vllm==0.29.0"`.                          |
| **Preflight Failed (Oversized)**   | Model exceeds dual T4 VRAM. Select an AWQ/GPTQ 4-bit quantized version or model <= 14B. |
| **Preflight Failed (FP8)**         | Tesla T4 lacks FP8 hardware. Select AWQ, GPTQ, or FP16 models.                          |
| **Preflight Failed (Gated)**       | Model requires HF license agreement. Export `HF_TOKEN` from Kaggle Secrets.             |
| **GPU out of memory**              | Run `./infra/kaggle/vllm.sh clean` or `./infra/kaggle/qwen-vllm.sh clean`.              |
| **Port 8000 occupied**             | Run `./infra/kaggle/vllm.sh clean`.                                                     |
| **Weights still loading**          | Run `./infra/kaggle/vllm.sh logs 50` or `tail -f /kaggle/working/vllm_server.log`.      |
| **Tunnel URL missing**             | Run `./infra/kaggle/cloudflared.sh logs 30`. Verify internet is enabled in Kaggle.      |
| **Full Stack Health**              | Run `./infra/kaggle/diagnostics.sh all`.                                                |
| **Python `SyntaxError` in Kaggle** | Ensure Bash commands are inside a `%%bash` cell instead of a normal Python cell.        |
