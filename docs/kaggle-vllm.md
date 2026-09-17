# Generic Hugging Face → Kaggle → vLLM Deployment Guide

This document is the operational guide and technical reference for deploying **supported Hugging Face models** on a **Kaggle dual NVIDIA Tesla T4 GPU environment** using **vLLM 0.29.0**, exposing the backend over a **Cloudflare Quick Tunnel**, and integrating the model endpoint into the **Relay** gateway.

> [!NOTE]
> **Ephemeral Testing Environment**: Kaggle GPU sessions are temporary (typically 9–12 hours) and intended for evaluation, integration testing, and development. In production, deploy vLLM on dedicated GPU nodes, Kubernetes clusters, or private cloud VPCs.

---

## What This System Does

The self-service deployment system allows an operator to specify any Hugging Face `MODEL_ID` in a single configuration cell and execute a complete deployment lifecycle with **Run All**:

1. **Hardware Inspection**: Detects GPU count, VRAM availability, and Turing CUDA capabilities.
2. **Model Discovery & Preflight**: Inspects the model on Hugging Face Hub, validates architecture support in vLLM, verifies quantization compatibility with Tesla T4s, and calculates VRAM feasibility.
3. **Safe Parameter Resolution**: Automatically derives optimal execution arguments (`--dtype float16`, `--tensor-parallel-size 2`, bounded `--max-model-len`, `--enforce-eager`) while honoring explicit user overrides.
4. **Daemon Lifecycle Management**: Launches `vllm serve` in the background, tracks process PIDs, and prevents port conflicts.
5. **Readiness & Validation**: Polls `/v1/models` until weights load and KV cache compiles, then executes local non-streaming and SSE streaming validation tests.
6. **Cloudflare Quick Tunnel**: Starts `cloudflared` to expose the private Kaggle port over an encrypted HTTPS URL (`*.trycloudflare.com`).
7. **Relay Configuration Generation**: Outputs ready-to-copy Relay configuration snippets (both `.env` single-provider and `ADDITIONAL_PROVIDERS` multi-provider JSON).

---

## Architectural Flow

```text
 Developer Machine (Relay Gateway)
          │
          │ HTTPS (OpenAI-compatible /v1/chat/completions)
          ▼
 Cloudflare Quick Tunnel (*.trycloudflare.com)
          │
          │ Outbound Encrypted Tunnel
          ▼
 Kaggle Compute Container (2× NVIDIA Tesla T4)
          │
          │ Loopback (http://127.0.0.1:8000/v1)
          ▼
 vLLM Engine (vllm serve, TP=2, FP16, Enforce-Eager)
          │
          │ Tensor-Parallel Model Execution
          ▼
 Hugging Face Model (e.g., Qwen2.5-Coder-7B, Llama-3-8B, Qwen3-Coder-30B-AWQ)
```

---

## Model Selection & Dual Tesla T4 Hardware Constraints

> [!IMPORTANT]
> **Not every Hugging Face model can be automatically deployed on Kaggle.**
> The Tesla T4 hardware imposes strict physical and architectural boundaries that no software configuration can bypass.

### 1. Tesla T4 Hardware Profile

- **GPU Type**: 2× NVIDIA Tesla T4 (Turing microarchitecture, Compute Capability 7.5).
- **VRAM**: ~15,109 MiB usable per GPU (~30 GB total VRAM across both GPUs).
- **Precision Support**: Native `float16` and `int8`.
- **Hardware Limitations**:
  - **No native `bfloat16`**: Running `bfloat16` on T4 triggers software emulation, resulting in severe latency or vLLM initialization errors. All models run with `--dtype float16`.
  - **No FP8 Tensor Cores**: FP8 execution requires Ada Lovelace (CC 8.9+) or Hopper (CC 9.0+). Models pre-quantized in FP8 **cannot** run on Tesla T4.

### 2. Supported Model Classes

| Model Class                      | Parameter Range                | Precision / Quantization     |  Usable on Dual T4?  | Rationale                                                                                                         |
| :------------------------------- | :----------------------------- | :--------------------------- | :------------------: | :---------------------------------------------------------------------------------------------------------------- |
| **Small Dense Text Models**      | 0.5B – 3B                      | Unquantized FP16 / BF16      |       **Yes**        | Weights consume 1–6 GB total; fits comfortably on 1 or 2 GPUs.                                                    |
| **Mid Dense Text Models**        | 7B – 8B                        | Unquantized FP16 / BF16      |       **Yes**        | Weights require ~14–16 GB. With `TP=2`, weights take ~7–8 GB per GPU, leaving ~7 GB for KV cache and activations. |
| **Large Dense Text Models**      | 13B – 14B                      | Unquantized FP16 / BF16      | **Marginal / Tight** | Weights take ~26–28 GB total. Minimal KV cache headroom remains. Requires small `MAX_MODEL_LEN` (e.g. 2048).      |
| **Multimodal Vision/OCR Models** | ~0.9B (e.g. `zai-org/GLM-OCR`) | Unquantized FP16 / BF16      |       **Yes**        | Supported in vLLM. Weights take ~2 GB in FP16 with ~1 GB vision encoder overhead; fits easily on dual T4.         |
| **Oversized Unquantized**        | > 14B (e.g. 27B, 32B, 70B)     | Unquantized FP16             |  **No (Rejected)**   | Weights exceed 30 GB total VRAM. Will crash with Out of Memory (OOM).                                             |
| **Quantized 4-Bit Models**       | 7B – 14B                       | AWQ or GPTQ 4-bit            |       **Yes**        | Weights take ~4–9 GB total. High throughput and large KV cache headroom.                                          |
| **Quantized 4-Bit Models**       | 30B – 32B (or MoE)             | AWQ or GPTQ 4-bit            |       **Yes**        | Weights take ~15–18 GB total (~7.5–9 GB per GPU). Fits on dual T4 (e.g., Qwen3-Coder-30B-A3B AWQ).                |
| **Oversized Quantized**          | > 33B (e.g. 70B AWQ)           | AWQ or GPTQ 4-bit            |  **No (Rejected)**   | Weights require > 35 GB VRAM; exceeds dual T4 capacity.                                                           |
| **FP8 Models**                   | Any size                       | FP8 (`neuralmagic/`, etc.)   |  **No (Rejected)**   | Tesla T4 lacks hardware FP8 tensor cores.                                                                         |
| **Non-Causal Models**            | Any size                       | BERT, RoBERTa, CLIP, Whisper |  **No (Rejected)**   | vLLM `serve` is designed for causal autoregressive text and multimodal generative generation.                     |

---

## Configuration Reference

In [`notebooks/vllm-kaggle.ipynb`](../notebooks/vllm-kaggle.ipynb), the top configuration cell contains all deployment parameters:

```python
# Target Hugging Face Model (Text Causal LM or Multimodal Vision/OCR LM)
# Example A (Text Causal LM):
MODEL_ID = "Qwen/Qwen2.5-Coder-7B-Instruct"
SERVED_MODEL_NAME = "qwen2.5-coder-7b"

# Example B (Multimodal Document / OCR LM):
# MODEL_ID = "zai-org/GLM-OCR"
# SERVED_MODEL_NAME = "glm-ocr"

# Hardware & Concurrency Settings (Defaults optimized for dual Tesla T4)
TENSOR_PARALLEL_SIZE = 2
MAX_MODEL_LEN = 4096
MAX_NUM_SEQS = 4
GPU_MEMORY_UTILIZATION = 0.85

# Optional Overrides (Set to None to let preflight auto-detect/auto-resolve)
DTYPE = None          # Auto-resolved: float16 on T4
QUANTIZATION = None   # Auto-detected from HF config (e.g. awq, gptq)
TRUST_REMOTE_CODE = None # Auto-resolved: True for custom causal/multimodal LMs
EXTRA_VLLM_ARGS = None   # Optional additional CLI flags (e.g. "--limit-mm-per-prompt image=1")

# Hugging Face Access Token (for gated/private models)
HF_TOKEN = None
```

### Parameter Explanations

| Parameter                | Default            | Description & Behavior                                                                                                                       |
| :----------------------- | :----------------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODEL_ID`               | _Required_         | Hugging Face repository ID (e.g., `Qwen/Qwen2.5-Coder-7B-Instruct`, `zai-org/GLM-OCR`, `meta-llama/Llama-3.1-8B-Instruct`).                  |
| `SERVED_MODEL_NAME`      | Sanitized basename | OpenAI API model alias registered in vLLM. Must be a single, clean alias string.                                                             |
| `TENSOR_PARALLEL_SIZE`   | `2`                | Number of GPUs to shard model weights across. Dual T4 requires `2` for models >= 7B.                                                         |
| `MAX_MODEL_LEN`          | `4096`             | Context length limit. If the model config defines a smaller context, preflight caps to the native length. Minimum 512 for multimodal models. |
| `MAX_NUM_SEQS`           | `4`                | Maximum concurrent request sequences handled by vLLM. Preserves VRAM headroom.                                                               |
| `GPU_MEMORY_UTILIZATION` | `0.85`             | Fraction of GPU memory allocated to vLLM (weights + KV cache). Reserves ~15% for CUDA runtime.                                               |
| `DTYPE`                  | `None`             | Precision override. Preflight enforces `float16` for Tesla T4.                                                                               |
| `QUANTIZATION`           | `None`             | Quantization override (`awq`, `gptq`). If `None`, preflight auto-detects from model `config.json`.                                           |
| `TRUST_REMOTE_CODE`      | `None`             | Automatically set to `True` for causal and multimodal LMs requiring custom modeling code.                                                    |
| `EXTRA_VLLM_ARGS`        | `None`             | Additional CLI flags passed directly to `vllm serve` (e.g. `--limit-mm-per-prompt image=1`).                                                 |
| `HF_TOKEN`               | `None`             | Access token for gated or private Hugging Face repositories. Masked in all logs.                                                             |

---

## Configuration Resolution Precedence

Configuration values are resolved following strict precedence:

```text
 1. User Overrides (Explicit environment variables / notebook parameters)
         ↓
 2. Model Metadata (Hugging Face Hub API, config.json, quantization_config)
         ↓
 3. Hardware-Safe Defaults (Dual Tesla T4 CC 7.5: float16, enforce-eager, TP=2)
         ↓
 4. Final Generated `vllm serve` Command
```

---

## Authenticated & Gated Models

Models such as `meta-llama/Meta-Llama-3-8B-Instruct` require accepting a license agreement on Hugging Face before accessing repository files.

### Recommended Token Workflow (Kaggle Secrets)

1. Open your Kaggle Notebook.
2. In the top menu bar, click **Add-ons** $\to$ **Secrets**.
3. Add a new secret:
   - **Label**: `HF_TOKEN`
   - **Value**: Your Hugging Face read token (`hf_...`).
4. Enable the toggle next to `HF_TOKEN` for the notebook.
5. The notebook configuration cell will automatically read the secret:
   ```python
   from kaggle_secrets import UserSecretsClient
   HF_TOKEN = UserSecretsClient().get_secret("HF_TOKEN")
   ```

> [!SECURITY]
> Secrets and tokens are never printed in plain text. Preflight automatically masks tokens (`hf_1...cdef`) in console logs and diagnostic reports.

---

## Step-by-Step Run All Execution

1. **Open Notebook**: Create a new notebook on Kaggle and paste or upload [`notebooks/vllm-kaggle.ipynb`](../notebooks/vllm-kaggle.ipynb).
2. **Select Accelerator**: In the right sidebar under **Notebook settings**, select **Accelerator** $\to$ **GPU T4 x2**.
3. **Enable Internet**: Ensure **Internet on** is toggled in the right sidebar.
4. **Set Model ID**: In Cell 2, set `MODEL_ID = "Your/Model-Name"`.
5. **Click Run All**:
   - Step 1: Validates two Tesla T4 GPUs are allocated.
   - Step 2: Clones the Relay repository into `/kaggle/working/Relay`.
   - Step 3: Applies `chmod +x` to infrastructure scripts.
   - Step 4: Runs preflight validation (`./infra/kaggle/vllm.sh preflight`).
   - Step 5: Confirms `vllm==0.29.0` CLI is installed.
   - Step 6: Cleans stale listeners on port 8000.
   - Step 7: Starts vLLM in the background.
   - Step 8: Polls `/v1/models` until ready.
   - Step 9–11: Runs local inference and SSE streaming tests.
   - Step 12: Provisions Cloudflare Quick Tunnel and extracts public URL.
   - Step 13–14: Runs public end-to-end verification.
   - Step 15: Prints ready-to-copy Relay configuration.

---

## Connecting to Relay

At the end of the notebook execution, the script prints a ready-to-copy Relay configuration snippet using the multi-provider `ADDITIONAL_PROVIDERS` JSON schema.

Add this snippet to your local Relay `.env` file:

```dotenv
ADDITIONAL_PROVIDERS='[
  {
    "id": "kaggle-qwen2.5-coder-7b",
    "name": "Kaggle vLLM (Qwen/Qwen2.5-Coder-7B-Instruct)",
    "baseUrl": "https://<tunnel-subdomain>.trycloudflare.com/v1",
    "models": ["qwen2.5-coder-7b"]
  }
]'
```

Then query the model through Relay:

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5-coder-7b",
    "messages": [{"role": "user", "content": "Explain binary search in Rust"}]
  }'
```

---

## CLI Management Script: `infra/kaggle/vllm.sh`

The shell script [`infra/kaggle/vllm.sh`](../infra/kaggle/vllm.sh) provides complete command-line lifecycle control:

```bash
# Verify environment and dependencies
./infra/kaggle/vllm.sh check

# Run preflight inspection on MODEL_ID
./infra/kaggle/vllm.sh preflight

# Clean stale processes on port 8000
./infra/kaggle/vllm.sh clean

# Launch vLLM daemon in background
./infra/kaggle/vllm.sh start

# Probe server readiness and registered models
./infra/kaggle/vllm.sh status

# Execute smoke test inference
./infra/kaggle/vllm.sh test

# View the last 50 lines of vLLM server logs
./infra/kaggle/vllm.sh logs 50

# Safely terminate vLLM and release VRAM
./infra/kaggle/vllm.sh stop
```

---

## Troubleshooting & Failure Isolation

### 6-Step Failure Isolation Hierarchy

When requests through the public tunnel fail, isolate the cause in this exact order:

1. **Local Endpoint**: `curl http://127.0.0.1:8000/v1/models`
   - _If fails_: vLLM crashed or is still loading weights. Check `./infra/kaggle/vllm.sh logs 50`.
2. **Local Inference**: `./infra/kaggle/vllm.sh test`
   - _If fails_: Forward pass out of memory or engine compilation error.
3. **Tunnel Daemon**: `./infra/kaggle/cloudflared.sh status`
   - _If fails_: `cloudflared` process stopped. Restart with `./infra/kaggle/cloudflared.sh start`.
4. **Tunnel Logs**: `./infra/kaggle/cloudflared.sh logs 30`
   - _If errors_: Rate-limiting or network disconnection at Cloudflare edge.
5. **Public Model Discovery**: `curl https://<subdomain>.trycloudflare.com/v1/models`
   - _If fails_: DNS edge propagation delay. Wait 15–30 seconds.
6. **Public Chat Completion**: `curl -X POST https://<subdomain>.trycloudflare.com/v1/chat/completions ...`
   - _If fails_: Payload validation error or client request timeout.

---

## Known Limitations

1. **Ephemeral Lifespan**: Kaggle compute sessions terminate automatically after 9–12 hours or 40–60 minutes of browser inactivity.
2. **Dynamic URLs**: Cloudflare Quick Tunnels generate a new random URL on every startup. You must update your local Relay configuration when restarting a session.
3. **Hardware Ceiling**: Models requiring more than 30 GB VRAM cannot fit on Kaggle's dual Tesla T4 GPUs.
4. **No FP8 on T4**: FP8 quantized weights cannot execute on Turing hardware.
