# Relay Kaggle Infrastructure Scripts

This directory contains production-tested, reproducible management scripts for deploying self-hosted LLM backends via **vLLM** on a Kaggle dual NVIDIA Tesla T4 GPU environment and exposing them securely to Relay over a Cloudflare Quick Tunnel.

Two deployment workflows are supported:

1. **Generic Hugging Face Deployment (`vllm.sh` + `preflight.py`)**: A model-agnostic, parameter-driven system capable of inspecting any compatible Hugging Face model, resolving hardware-safe execution parameters for dual Tesla T4s, and managing the server lifecycle.
2. **Qwen Reference Deployment (`qwen-vllm.sh`)**: The stable, turn-key reference configuration for `QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ`.

---

## Script Index

| Script               | Purpose                                                                                         | Key Subcommands                                                              |
| :------------------- | :---------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------- |
| **`vllm.sh`**        | Generic vLLM lifecycle manager driven by environment variables and preflight resolution.        | `check`, `preflight`, `clean`, `start`, `status`, `test`, `logs [N]`, `stop` |
| **`preflight.py`**   | Hugging Face Hub inspector and hardware compatibility validator (standard library Python 3.8+). | `--model-id`, `--json`, `--tensor-parallel-size`, `--hf-token`, `--extra-vllm-args` |
| **`test_image.py`**  | Pure standard library PNG generator and base64 data URI encoder for multimodal OCR smoke tests. | `[text]` (prints `data:image/png;base64,...`)                                |
| **`qwen-vllm.sh`**   | Dedicated reference manager for Qwen3-Coder-30B-AWQ.                                            | `check`, `clean`, `start`, `status`, `test`, `logs [N]`, `stop`              |
| **`cloudflared.sh`** | Manages `cloudflared` binary download, background tunnel execution, and dynamic URL discovery.  | `check`, `start`, `status`, `url`, `logs [N]`, `stop`                        |
| **`diagnostics.sh`** | Comprehensive 10-point system, GPU, CUDA, process, network, and tunnel diagnostic suite.        | `all`, `gpu`, `cuda`, `vllm`, `tunnel`, `network`, `logs`                    |

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

The generic workflow allows you to deploy any compatible causal language model or multimodal vision/OCR model simply by setting `MODEL_ID`:

```bash
%%bash
cd /kaggle/working/Relay
export MODEL_ID="Qwen/Qwen2.5-Coder-7B-Instruct"
export SERVED_MODEL_NAME="qwen2.5-coder-7b"

# To deploy GLM-OCR instead:
# export MODEL_ID="zai-org/GLM-OCR"
# export SERVED_MODEL_NAME="glm-ocr"

# 1. Preflight validation
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

### Preflight Compatibility & Hardware Policy

The preflight validator (`preflight.py`) inspects model metadata via the official Hugging Face Hub API and validates:

- **Architecture Support**: Validates causal text models (`Qwen2ForCausalLM`, `LlamaForCausalLM`, `MistralForCausalLM`, etc.) and multimodal generative models (`GlmOcrForConditionalGeneration`, `Qwen2VLForConditionalGeneration`, etc.). Rejects encoder-only, audio, classification, and diffusion architectures.
- **T4 Hardware Precision**: Enforces `float16` by default. Rejects FP8 models because Tesla T4 (Turing CC 7.5) lacks FP8 tensor cores.
- **VRAM Heuristic**: Estimates total parameter footprint including vision encoder overhead against dual Tesla T4 capacity (~30 GB usable VRAM). Rejects unquantized models > 14B and 4-bit models > 32B with actionable guidance.
- **Gated Models**: Checks whether model repository is gated/private and verifies that `HF_TOKEN` is present without logging raw secrets.

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
