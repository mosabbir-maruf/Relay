# Kaggle Deployment Runbook: Self-Hosted Qwen3-Coder via vLLM

This document is the definitive, reproducible runbook for deploying **`QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ`** on a **Kaggle Notebook with 2× NVIDIA Tesla T4 GPUs** using **vLLM 0.29.0**, and connecting it securely to Relay over a Cloudflare Quick Tunnel.

> [!NOTE]
> **Development & Testing Scope**:
> This setup is designed for development, experimentation, and functional verification of Relay's multi-provider capabilities. Kaggle provides an ephemeral GPU session (up to 9–12 hours). It is **not** a persistent production host. In production environments, deploy vLLM on dedicated servers, Kubernetes clusters, or private cloud VPCs.

---

## 1. Last Verified Configuration

This exact configuration was verified on Kaggle hardware on **September 16, 2026**:

| Parameter                  | Verified Value                               | Rationale / Constraint                                                                                                                                |
| :------------------------- | :------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Model**                  | `QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ` | 30.5B MoE (~3.3B active). Unquantized FP16 requires 61 GB VRAM (exceeds dual T4 capacity). AWQ 4-bit weights fit in ~15.2 GB total (~7.6 GB per GPU). |
| **Served Model Name**      | `qwen3-coder-30b`                            | **Must be a single name**. Passing comma-separated values was treated as a literal compound name by vLLM.                                             |
| **vLLM Version**           | `0.29.0`                                     | Installed via `pip install vllm`.                                                                                                                     |
| **Hardware**               | 2× NVIDIA Tesla T4                           | 16 GB VRAM per GPU (~15,109 MiB usable).                                                                                                              |
| **Tensor Parallel Size**   | `2`                                          | Distributes weights evenly across both GPUs (`--tensor-parallel-size 2`).                                                                             |
| **DType**                  | `float16`                                    | **Mandatory**. Tesla T4 (Turing, compute capability 7.5) does not support native `bfloat16` or `fp8` tensor cores.                                    |
| **Quantization**           | `awq`                                        | Required to load AWQ 4-bit quantized weights.                                                                                                         |
| **Max Model Length**       | `4096`                                       | Bounds KV cache allocation to prevent out-of-memory errors on 15 GB VRAM.                                                                             |
| **Max Num Sequences**      | `4`                                          | Concurrency limit to reserve VRAM for peak activations.                                                                                               |
| **GPU Memory Utilization** | `0.85`                                       | Leaves ~15% VRAM headroom for PyTorch context, CUDA kernels, and fragmentation.                                                                       |
| **Enforce Eager**          | `true` (`--enforce-eager`)                   | Disables CUDA graph capture, saving ~1–2 GB VRAM per GPU on memory-constrained T4s.                                                                   |
| **Trust Remote Code**      | `true` (`--trust-remote-code`)               | Required by the Qwen3 model architecture.                                                                                                             |
| **Host / Port**            | `0.0.0.0:8000`                               | Exposes standard OpenAI-compatible `/v1` endpoints locally.                                                                                           |

> [!WARNING]
> Do **NOT** pass `--swap-space`. This flag was rejected by the verified vLLM 0.29.0 installation on Kaggle.  
> Do **NOT** use `vllm server`. The correct CLI subcommand is `vllm serve`.

---

## 2. Prerequisites & Kaggle Setup

1. Open or create a new Kaggle Notebook.
2. In the right sidebar under **Notebook settings**:
   - **Accelerator**: `GPU T4 x2` _(Requires phone-verified Kaggle account)_.
   - **Internet**: `On` _(Required to download weights and run the tunnel)_.
   - **Environment**: `Always use latest environment`.
3. Verify that `/usr/local/lib/python3.12/dist-packages/nvidia/cu13/lib` is present if importing CUDA 13 libraries in Python.

---

## 3. Step-by-Step Execution Guide

You can run this setup either using the canonical notebook at [`notebooks/qwen-vllm-kaggle.ipynb`](../notebooks/qwen-vllm-kaggle.ipynb) or using the shell scripts in [`infra/kaggle/`](../infra/kaggle/).

### Step 1: Environment & GPU Verification

Verify the dual GPU environment before downloading anything:

```bash
!nvidia-smi --query-gpu=index,name,memory.total,memory.free --format=csv,noheader
```

_Expected output_: Two lines reporting `Tesla T4` with ~15,109 MiB free each.

### Step 2: Install vLLM & cloudflared

```bash
%%bash
pip install -q --no-cache-dir vllm
wget -q -nc https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /kaggle/working/cloudflared
chmod +x /kaggle/working/cloudflared
```

### Step 3: Clean Stale Processes (If Restarting)

If restarting after a failure, stale Python workers may still occupy GPU memory:

```bash
%%bash
# Safely kill any lingering vLLM processes
pkill -f vllm || true
sleep 3
nvidia-smi --query-gpu=index,memory.used,memory.free --format=csv,noheader
```

### Step 4: Launch vLLM in the Background

> [!IMPORTANT]
> **Why Background Execution is Mandatory**: A Kaggle notebook cell executes synchronously. Running `vllm serve` in the foreground blocks the notebook indefinitely, preventing you from running subsequent cells to test inference or start the tunnel.

Launch vLLM with logs piped to `/kaggle/working/vllm_server.log`:

```bash
%%bash --bg
export LD_LIBRARY_PATH="/usr/local/lib/python3.12/dist-packages/nvidia/cu13/lib:$LD_LIBRARY_PATH"

vllm serve QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ \
  --served-model-name qwen3-coder-30b \
  --host 0.0.0.0 \
  --port 8000 \
  --tensor-parallel-size 2 \
  --dtype float16 \
  --quantization awq \
  --max-model-len 4096 \
  --max-num-seqs 4 \
  --gpu-memory-utilization 0.85 \
  --enforce-eager \
  --trust-remote-code \
  > /kaggle/working/vllm_server.log 2>&1
```

### Step 5: Wait for Readiness

vLLM takes ~2–3 minutes to download cached weights and compile the KV cache. Poll the `/v1/models` endpoint:

```python
import urllib.request, json, time

for i in range(120):
    time.sleep(3)
    try:
        req = urllib.request.Request("http://127.0.0.1:8000/v1/models")
        with urllib.request.urlopen(req, timeout=2) as resp:
            if resp.status == 200:
                print("vLLM is ONLINE and healthy!")
                print(json.loads(resp.read().decode()))
                break
    except Exception:
        if i % 10 == 0:
            print(f"Loading weights... ({i * 3}s elapsed)")
```

### Step 6: Verify Local Inference (PONG Sanity Check)

Test prompt completion locally:

```bash
curl -X POST http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder-30b",
    "messages": [{"role": "user", "content": "Reply with only the uppercase word PONG"}],
    "temperature": 0.0,
    "max_tokens": 16
  }'
```

_Expected output_: JSON response containing `"content": "PONG"`.

### Step 7: Launch Cloudflare Quick Tunnel

Start `cloudflared` pointing to `http://127.0.0.1:8000` in the background and dynamically extract the public URL:

```python
import subprocess, time, re, os

log_file = "/kaggle/working/cloudflared.log"
if os.path.exists(log_file):
    os.remove(log_file)

proc = subprocess.Popen(
    ["/kaggle/working/cloudflared", "tunnel", "--url", "http://127.0.0.1:8000", "--logfile", log_file],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL
)

tunnel_url = None
for _ in range(30):
    time.sleep(1)
    if os.path.exists(log_file):
        with open(log_file) as f:
            match = re.search(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", f.read())
            if match:
                tunnel_url = match.group(0)
                break

print("Public Tunnel URL:", tunnel_url)
```

### Step 8: Configure Local Relay `.env`

Copy the generated tunnel URL into your local Relay `.env` file:

```dotenv
QWEN_BASE_URL=https://<your-dynamic-subdomain>.trycloudflare.com/v1
QWEN_MODEL=qwen3-coder-30b
```

Run Relay locally:

```bash
pnpm dev
```

Test end-to-end through Relay on your machine:

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder-30b",
    "messages": [{"role": "user", "content": "Hello Qwen through Relay!"}]
  }'
```

---

## 4. Troubleshooting & Diagnostics

Run `./infra/kaggle/diagnostics.sh all` or inspect specific conditions:

| Symptom                                             | Probable Cause                                                                             | Remediation                                                                                              |
| :-------------------------------------------------- | :----------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------- |
| **CUDA out of memory during startup**               | A prior Python process is still holding VRAM on GPU 0 or 1.                                | Run `pkill -f vllm`, check with `nvidia-smi`, wait 5s for VRAM to drop to 0.                             |
| **`ImportError: libcudart.so.13`**                  | PyTorch CUDA 13 libraries not on dynamic linker path.                                      | Run `export LD_LIBRARY_PATH="/usr/local/lib/python3.12/dist-packages/nvidia/cu13/lib:$LD_LIBRARY_PATH"`. |
| **`unrecognized arguments: --swap-space`**          | `--swap-space` flag was deprecated or removed in vLLM 0.29.0.                              | Omit `--swap-space`. Use `--gpu-memory-utilization 0.85` instead.                                        |
| **Model name returned is compound (`model,alias`)** | Comma-separated values passed to `--served-model-name`.                                    | Pass a single name: `--served-model-name qwen3-coder-30b`.                                               |
| **Port 8000 already in use**                        | A previous instance is still bound to port 8000.                                           | Run `lsof -ti:8000 \| xargs kill -9`.                                                                    |
| **Cloudflare Tunnel URL fails to connect**          | vLLM is still compiling KV cache and not yet responding on port 8000.                      | Verify `curl http://127.0.0.1:8000/v1/models` returns 200 before using the public URL.                   |
| **Public URL returns HTTP 530 / Error 1033**        | Cloudflare Tunnel is running, but the local destination (`http://127.0.0.1:8000`) is down. | Inspect `/kaggle/working/vllm_server.log` to check if vLLM crashed.                                      |

---

## 5. Safe Shutdown Procedure

To release GPU memory and terminate processes cleanly:

```bash
%%bash
# 1. Stop Cloudflare Tunnel
pkill -f cloudflared || true

# 2. Stop vLLM server
pkill -f vllm || true
sleep 3

# 3. Confirm GPU memory is cleared
nvidia-smi --query-gpu=index,name,memory.used,memory.free --format=csv,noheader
```

---

## 6. Important Limitations

1. **Session Lifespan**: Kaggle notebook sessions are terminated after 12 hours (or after 60 minutes of inactivity if the browser is closed).
2. **Ephemeral Storage**: Files in `/kaggle/working` are wiped when the notebook session stops. Re-running the notebook downloads fresh packages and cached weights.
3. **Dynamic Quick Tunnel URLs**: Every time `cloudflared` starts, Cloudflare assigns a new random `trycloudflare.com` subdomain. You must update `QWEN_BASE_URL` in your local `.env` whenever the tunnel restarts.
4. **Development Only**: Quick Tunnels have no SLA and are throttled by Cloudflare. For production serving, run vLLM on persistent compute with a dedicated domain.
