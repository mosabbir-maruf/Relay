# Kaggle Deployment Runbook: Self-Hosted Qwen3-Coder via vLLM

This document is the definitive, reproducible runbook for deploying **`QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ`** on a **Kaggle Notebook with 2× NVIDIA Tesla T4 GPUs** using **vLLM 0.29.0**, exposing it over a **Cloudflare Quick Tunnel**, and integrating it with Relay.

> [!NOTE]
> **Development & Testing Scope**:
> This setup is designed for development, experimentation, and functional verification of Relay's multi-provider capabilities. Kaggle provides an ephemeral GPU session (up to 9–12 hours). It is **not** a persistent production host. In production environments, deploy vLLM on dedicated GPU servers, Kubernetes clusters, or private cloud VPCs.

---

## Architecture Overview

```text
 Developer / Relay (Local Dev Machine)
         │
         │ HTTPS Request (OpenAI-compatible)
         ▼
 Cloudflare Quick Tunnel (*.trycloudflare.com)
         │
         │ Reverse Proxy over Outbound Tunnel
         ▼
 Kaggle Linux Container (dual NVIDIA T4)
         │
         │ Loopback (http://127.0.0.1:8000/v1)
         ▼
 vLLM Engine (vllm serve, TP=2, FP16, AWQ)
         │
         │ Tensor-Parallel Execution
         ▼
 Qwen3-Coder-30B-A3B-Instruct-AWQ (30.5B MoE, ~3.3B active)
```

---

## Verified Configuration Reference

Verified on Kaggle hardware on **September 16, 2026**:

| Parameter                  | Verified Value                               | Rationale & Operational Constraint                                                                                                             |
| :------------------------- | :------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- |
| **Model**                  | `QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ` | 30.5B MoE (~3.3B active). Unquantized FP16 requires 61 GB VRAM (exceeds dual T4 capacity). AWQ 4-bit fits in ~15.2 GB total (~7.6 GB per GPU). |
| **Served Model Name**      | `qwen3-coder-30b`                            | **Must be a single name**. Passing comma-separated values causes vLLM to register a literal compound string (`QuantTrio/...,qwen3-coder-30b`). |
| **vLLM Subcommand**        | `vllm serve`                                 | **Mandatory**. Never use `vllm server` (fails with unrecognized command).                                                                      |
| **Hardware**               | 2× NVIDIA Tesla T4                           | ~15,109 MiB usable VRAM per GPU.                                                                                                               |
| **Tensor Parallel Size**   | `2`                                          | Splits model weights evenly across both GPUs (`--tensor-parallel-size 2`).                                                                     |
| **DType**                  | `float16`                                    | **Mandatory**. Tesla T4 (Turing, compute capability 7.5) lacks hardware support for native `bfloat16` or `fp8` tensor cores.                   |
| **Quantization**           | `awq`                                        | Required for AWQ 4-bit quantized weight unpacking.                                                                                             |
| **Max Model Length**       | `4096`                                       | Bounds KV cache allocation to prevent out-of-memory errors on 15 GB VRAM.                                                                      |
| **Max Num Sequences**      | `4`                                          | Concurrency limit reserving VRAM headroom for activation peaks.                                                                                |
| **GPU Memory Utilization** | `0.85`                                       | Reserves ~15% VRAM for PyTorch context, CUDA kernels, and memory fragmentation.                                                                |
| **Enforce Eager**          | `true` (`--enforce-eager`)                   | Bypasses CUDA graph capture, saving ~1–2 GB VRAM overhead per GPU on memory-constrained T4s.                                                   |
| **Trust Remote Code**      | `true` (`--trust-remote-code`)               | Required by the Qwen3 architecture.                                                                                                            |
| **Host / Port**            | `0.0.0.0:8000`                               | Exposes standard OpenAI-compatible `/v1` endpoints locally.                                                                                    |

> [!WARNING]
> Do **NOT** pass `--swap-space`. This flag was removed/unsupported in vLLM 0.29.0 on Kaggle.
> Do **NOT** use `vllm server`. The correct CLI subcommand is `vllm serve`.

---

## How Scripts Get into Kaggle: GitHub vs. Kaggle Filesystem

The management scripts are version-controlled in the Relay GitHub repository:

- GitHub location: `infra/kaggle/*.sh`

They are **not** created manually inside Kaggle. Instead, the notebook or terminal clones the repository into `/kaggle/working/Relay`:

```text
GitHub Repository:
https://github.com/mosabbir-maruf/Relay
         │
         │ git clone https://github.com/mosabbir-maruf/Relay.git /kaggle/working/Relay
         ▼
Kaggle Working Directory:
/kaggle/working/Relay/
         ├── infra/
         │     └── kaggle/
         │           ├── README.md
         │           ├── qwen-vllm.sh
         │           ├── cloudflared.sh
         │           └── diagnostics.sh
         └── notebooks/
               └── qwen-vllm-kaggle.ipynb
```

After cloning, all scripts reside at `/kaggle/working/Relay/infra/kaggle/*.sh`.

---

## 15-Stage Step-by-Step Deployment Runbook

### Stage 1: Kaggle Session Preparation

- **Where**: Kaggle Web Interface.
- **How**: Create a new notebook at [kaggle.com/code](https://www.kaggle.com/code).
- **Why**: Sets up an isolated Jupyter compute container.
- **What to Expect**: Fresh Kaggle notebook with `/kaggle/working` as the default directory.

### Stage 2: GPU Accelerator Selection

- **Where**: Kaggle Right Sidebar -> Notebook Settings.
- **How**:
  1. Set **Accelerator** to `GPU T4 x2` _(requires phone-verified account)_.
  2. Set **Internet** to `On` _(mandatory for cloning repo, downloading model weights, and establishing tunnel)_.
  3. Set **Environment** to `Always use latest environment`.
- **Why**: Tensor parallelism (`--tensor-parallel-size 2`) strictly requires two physical GPUs.
- **What to Expect**: `nvidia-smi` shows two Tesla T4 devices.
- **What if it fails**: If `GPU T4 x2` is grayed out, verify your Kaggle account with a phone number.

### Stage 3: Open the Canonical Notebook

- **Where**: Kaggle Notebook Editor.
- **How**: Import or copy cells from [`notebooks/qwen-vllm-kaggle.ipynb`](../notebooks/qwen-vllm-kaggle.ipynb).
- **Why**: Provides a cell-by-cell execution runner that orchestrates the automation scripts.

### Stage 4: Clone the Relay Repository

- **Where**: Kaggle Notebook Cell or Terminal.
- **How**:
  ```bash
  git clone https://github.com/mosabbir-maruf/Relay.git /kaggle/working/Relay
  cd /kaggle/working/Relay
  ```
- **Where the files are**: `/kaggle/working/Relay/infra/kaggle/`
- **Why**: Pulls the version-controlled management scripts into the container filesystem.
- **What to Expect**: Cloned repository at `/kaggle/working/Relay`, commit SHA printed.
- **What if it fails**: If `/kaggle/working/Relay` already exists, inspect `git status` or reuse the directory.

### Stage 5: Verify Kaggle Scripts

- **Where**: Kaggle Notebook / Terminal (`/kaggle/working/Relay`).
- **How**:
  ```bash
  ls -la infra/kaggle/
  ```
- **Why**: Verifies `qwen-vllm.sh`, `cloudflared.sh`, `diagnostics.sh`, and `README.md` are present.
- **What to Expect**: All 4 files exist and are readable.

### Stage 6: Apply Executable Permissions (`chmod +x`)

- **Where**: Kaggle Notebook / Terminal (`/kaggle/working/Relay`).
- **How**:
  ```bash
  chmod +x infra/kaggle/*.sh
  ```
- **Why**: Git preserves file content, but Kaggle's mounted filesystem requires explicit POSIX execute permissions (`+x`) before bash or python subprocesses can invoke `./infra/kaggle/<script>.sh` directly.
- **What to Expect**: `ls -l infra/kaggle/*.sh` confirms `-rwxr-xr-x` permissions.

### Stage 7: Preflight Environment Check & Dependencies

- **Where**: Kaggle Notebook / Terminal (`/kaggle/working/Relay`).
- **How**:
  ```bash
  pip install -q --no-cache-dir vllm
  ./infra/kaggle/qwen-vllm.sh check
  ```
- **Where the file is**: `/kaggle/working/Relay/infra/kaggle/qwen-vllm.sh`
- **Why**: Validates GPU visibility, checks that `vllm` CLI exists, and checks if port 8000 is free.
- **What to Expect**: Detected 2 GPUs, vLLM CLI path displayed, port 8000 free.
- **What if it fails**: If `vllm` not found, verify `pip install` succeeded. If fewer than 2 GPUs, check Accelerator settings.

### Stage 8: System & Hardware Diagnostics

- **Where**: Kaggle Notebook / Terminal (`/kaggle/working/Relay`).
- **How**:
  ```bash
  ./infra/kaggle/diagnostics.sh all
  ```
- **Where the file is**: `/kaggle/working/Relay/infra/kaggle/diagnostics.sh`
- **Why**: Runs 10-point check covering GPU memory, PyTorch CUDA device allocation, port occupancy, and background daemons. Useful when recovering from an aborted run.
- **What to Expect**: GPU status, PyTorch allocation PASS, and port check report.

### Stage 9: Safe Process Cleanup

- **Where**: Kaggle Notebook / Terminal (`/kaggle/working/Relay`).
- **How**:
  ```bash
  ./infra/kaggle/qwen-vllm.sh clean
  ```
- **Where the file is**: `/kaggle/working/Relay/infra/kaggle/qwen-vllm.sh`
- **Why**: Terminates any stale vLLM or Python worker processes holding port 8000 and releases leaked VRAM without touching Jupyter notebook processes.
- **What to Expect**: "Cleanup complete" or "No stale vLLM processes detected". GPU memory shows ~0 MiB used.

### Stage 10: Launch vLLM in Background

- **Where**: Kaggle Notebook / Terminal (`/kaggle/working/Relay`).
- **How**:
  ```bash
  ./infra/kaggle/qwen-vllm.sh start
  ```
- **Where the file is**: `/kaggle/working/Relay/infra/kaggle/qwen-vllm.sh`
- **Why**: Launches `vllm serve` with all verified flags via `nohup`, writes PID to `/kaggle/working/vllm.pid`, and redirects logs to `/kaggle/working/vllm_server.log`. Foreground execution would lock the notebook.
- **What to Expect**: "vLLM process launched with PID: <pid>". Process stays alive past initial 3s check.
- **What if it fails**: If process exits immediately, view logs: `./infra/kaggle/qwen-vllm.sh logs 50`.

### Stage 11: Wait for vLLM Readiness

- **Where**: Kaggle Notebook / Terminal.
- **How**: Poll `http://127.0.0.1:8000/v1/models` in a loop with a 10-minute timeout (weights download ~15.2 GB on first run).
  ```bash
  # Check status anytime:
  ./infra/kaggle/qwen-vllm.sh status
  # Or follow logs live:
  tail -f /kaggle/working/vllm_server.log
  ```
- **Why**: vLLM requires 2–4 minutes to load AWQ weights and pre-allocate the KV cache before the HTTP server accepts traffic.
- **What to Expect**: Transition from `[WAITING]` to `[READY] (HTTP 200)`.
- **What if it fails**: If timeout occurs, inspect `/kaggle/working/vllm_server.log`. Check for CUDA OOM or download errors.

### Stage 12: Local API Verification

- **Where**: Kaggle Notebook / Terminal (`/kaggle/working/Relay`).
- **How**:
  ```bash
  # 1. Check model registration
  curl -s http://127.0.0.1:8000/v1/models

  # 2. Run local inference test (sends PONG prompt)
  ./infra/kaggle/qwen-vllm.sh test
  ```
- **Where the file is**: `/kaggle/working/Relay/infra/kaggle/qwen-vllm.sh`
- **Why**: Verifies the local OpenAI-compatible endpoint responds with the exact model alias `qwen3-coder-30b` and generates valid tokens.
- **What to Expect**: Model list contains `"id": "qwen3-coder-30b"`; test prints `SUCCESS (HTTP 200)` and `PONG`.

### Stage 13: Cloudflare Quick Tunnel Provisioning

- **Where**: Kaggle Notebook / Terminal (`/kaggle/working/Relay`).
- **How**:
  ```bash
  # Check binary (downloads to /kaggle/working/cloudflared if missing)
  ./infra/kaggle/cloudflared.sh check

  # Launch tunnel in background and discover dynamic URL
  ./infra/kaggle/cloudflared.sh start
  ```
- **Where the file is**: `/kaggle/working/Relay/infra/kaggle/cloudflared.sh`
- **Why**: Establishes a secure outbound HTTPS tunnel targeting `http://127.0.0.1:8000` without requiring open firewall ports or static public IPs.
- **What to Expect**: Tunnel PID recorded in `/kaggle/working/cloudflared.pid`, dynamic public URL printed: `https://<random-id>.trycloudflare.com`.

### Stage 14: Public Endpoint Testing & Relay Integration

- **Where**:
  1. Kaggle Notebook: Run smoke test against the public URL.
  2. Local Dev Machine: Copy configuration into Relay's `.env`.
- **How**:
  In your local Relay repository `.env` on your computer:
  ```dotenv
  QWEN_BASE_URL=https://<your-subdomain>.trycloudflare.com/v1
  QWEN_MODEL=qwen3-coder-30b
  ```
  Start Relay locally:
  ```bash
  pnpm dev
  ```
  Send a test request to Relay:
  ```bash
  curl -X POST http://localhost:3000/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{
      "model": "qwen3-coder-30b",
      "messages": [{"role": "user", "content": "Hello Qwen through Relay!"}]
    }'
  ```
- **Why**: Validates end-to-end routing through Relay gateway to Kaggle vLLM.
- **What to Expect**: Relay streams or returns valid completion from Qwen3-Coder.

### Stage 15: Safe Shutdown Procedure

- **Where**: Kaggle Notebook / Terminal (`/kaggle/working/Relay`).
- **How**:
  ```bash
  ./infra/kaggle/cloudflared.sh stop
  ./infra/kaggle/qwen-vllm.sh stop
  ```
- **Where the files are**: `/kaggle/working/Relay/infra/kaggle/*.sh`
- **Why**: Stops the tunnel, sends SIGTERM (then SIGKILL if unresponsive) to vLLM, cleans PID files, and verifies GPU memory is 100% released.
- **What to Expect**: "Stopped cloudflared", "Process stopped cleanly", GPU memory released to ~0 MiB used.

---

## Troubleshooting Matrix

| Issue                                                      | Root Cause                                                         | Remediation Steps                                                                                                   |
| :--------------------------------------------------------- | :----------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| **`vllm: error: unrecognized subcommand 'server'`**        | Using deprecated `vllm server` CLI command.                        | Use canonical `vllm serve`.                                                                                         |
| **`unrecognized arguments: --swap-space`**                 | `--swap-space` is unsupported in vLLM 0.29.0 on Kaggle.            | Omit `--swap-space`. Manage memory with `--gpu-memory-utilization 0.85`.                                            |
| **Served model name returned is compound (`model,alias`)** | Comma-separated names passed to `--served-model-name`.             | Pass single string: `--served-model-name qwen3-coder-30b`.                                                          |
| **Stale vLLM worker processes / High VRAM on startup**     | Prior run aborted without stopping Python workers.                 | Run `./infra/kaggle/qwen-vllm.sh clean`, verify `nvidia-smi` shows ~0 MiB used before restarting.                   |
| **WorkerProc failed to start**                             | GPU memory exhausted, CUDA mismatch, or port conflict.             | Run `./infra/kaggle/diagnostics.sh all`, clean processes with `qwen-vllm.sh clean`, check `vllm_server.log`.        |
| **Port 8000 occupied**                                     | Previous server instance still listening.                          | Run `./infra/kaggle/qwen-vllm.sh clean`.                                                                            |
| **Server running but `/v1/models` not ready**              | Model weights (~15 GB) still downloading or KV cache initializing. | Inspect logs: `./infra/kaggle/qwen-vllm.sh logs 50` or `tail -f /kaggle/working/vllm_server.log`. Wait up to 5 min. |
| **`cloudflared` binary missing**                           | Running script before binary download.                             | Run `./infra/kaggle/cloudflared.sh check` to automatically download official release.                               |
| **Tunnel URL not detected**                                | Network lag or log format delay.                                   | Check logs: `./infra/kaggle/cloudflared.sh logs 30`. Verify internet is enabled in Kaggle settings.                 |
| **Public endpoint fails (HTTP 530 / Error 1033)**          | Break in the connectivity chain.                                   | **Follow the 6-Step Isolation Workflow below.**                                                                     |

---

## 6-Step Public Endpoint Failure Isolation Workflow

When a request to the public URL fails, follow this strict diagnostic order to pinpoint the exact failure layer:

1. **Step 1: Check Local `/v1/models`**
   ```bash
   curl -s http://127.0.0.1:8000/v1/models
   ```
   _If this fails_: vLLM server crashed or is still loading. Check `/kaggle/working/vllm_server.log`.
2. **Step 2: Check Local Inference**
   ```bash
   ./infra/kaggle/qwen-vllm.sh test
   ```
   _If this fails_: vLLM engine error or out of memory during token generation.
3. **Step 3: Check Cloudflare Process Status**
   ```bash
   ./infra/kaggle/cloudflared.sh status
   ```
   _If this fails_: `cloudflared` process died. Restart via `./infra/kaggle/cloudflared.sh start`.
4. **Step 4: Check Cloudflare Tunnel Logs**
   ```bash
   ./infra/kaggle/cloudflared.sh logs 30
   ```
   _If this shows errors_: Network disconnection or rate limiting on Quick Tunnel edges.
5. **Step 5: Check Public `/v1/models`**
   ```bash
   curl -s https://<dynamic-subdomain>.trycloudflare.com/v1/models
   ```
   _If this fails_: DNS propagation delay or Cloudflare edge connection issue.
6. **Step 6: Check Public Inference**
   ```bash
   curl -X POST https://<dynamic-subdomain>.trycloudflare.com/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model": "qwen3-coder-30b", "messages": [{"role": "user", "content": "PONG"}]}'
   ```
   _If this succeeds_: The backend and tunnel are fully verified. Configure Relay locally!
