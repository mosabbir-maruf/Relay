# Self-Hosted Models in Relay

Relay is a provider-agnostic LLM gateway and routing control plane. While Relay provides native support for commercial API providers like Google Gemini, it is designed from the ground up to support **self-hosted, open-weights LLMs** running on your own infrastructure or cloud GPU environments.

---

## 1. Architectural Separation: Deployment vs. Gateway

It is critical to distinguish between the **deployment layer** and the **gateway layer**:

```text
┌────────────────────────────────────────────────────────┐
│                   DEPLOYMENT LAYER                     │
│  (Hardware, Inference Engine, Weights & Tunneling)     │
│                                                        │
│  • Kaggle LLM Deployment (Dual NVIDIA Tesla T4s)       │
│  • Local vLLM / Ollama instance                        │
│  • Cloud GPU (RunPod, Lambda Labs, Vast.ai)            │
│  • Dedicated bare-metal Kubernetes cluster             │
│                                                        │
│                         ▼                              │
│            OpenAI-Compatible REST Endpoint             │
│          (e.g., https://<endpoint-host>/v1)            │
└─────────────────────────┬──────────────────────────────┘
                          │
                          ▼ (Standard HTTP / JSON / SSE)
┌────────────────────────────────────────────────────────┐
│                    GATEWAY LAYER                       │
│                   (Relay Gateway)                      │
│                                                        │
│  • Unified OpenAI Wire Protocol (v1/chat/completions)  │
│  • Provider Registry & Routing Policies                │
│  • Automatic Retries, Fallbacks & Circuit Breakers     │
│  • Rate Limiting & API Key Authentication              │
│  • Streaming (SSE) & Usage Telemetry Logging           │
│  • Playground UI for Interactive Testing               │
└────────────────────────────────────────────────────────┘
```

- **Relay does not manage GPU hardware, model weights, or CUDA drivers.**
- **Relay simply consumes any standard OpenAI-compatible `/v1` endpoint.**

---

## 2. Deploying a Self-Hosted Model

You can run any self-hosted engine (vLLM, Ollama, TGI, SGLang) on any platform.

If you want a free, turn-key, parameter-driven workflow on dual NVIDIA Tesla T4 GPUs (32 GB total VRAM), use the standalone deployment framework:

👉 **[Kaggle LLM Deployment Framework](https://github.com/mosabbir-maruf/kaggle-llm-deployment)**

The Kaggle LLM Deployment repository includes:

- Automated hardware preflight validation (`preflight.py`) for causal language models and multimodal vision models.
- Hardware-safe execution recommendations for Turing Tesla T4 GPUs (`float16`, tensor parallelism `TP=2`).
- Lifecycle management scripts (`vllm.sh`) and 10-point diagnostics (`diagnostics.sh`).
- Automated Cloudflare tunneling (`cloudflared.sh`) to expose the endpoint securely without public IP or port forwarding.
- Ready-to-use parameter profiles for Qwen 2.5, Llama 3.1, SmolVLM2, and DeepSeek R1 Distill.

---

## 3. Obtaining the Endpoint URL

After your self-hosted inference server starts:

1. **Local Deployments** (vLLM / Ollama on same machine or local LAN):
   - Base URL: `http://127.0.0.1:8000/v1`
2. **Cloudflare Quick Tunnel** (Development & Prototyping):
   - Base URL: `https://<random-id>.trycloudflare.com/v1`
   - _Note_: Quick Tunnels do not support Server-Sent Events (SSE). Uncheck `Stream` in Relay Playground or disable streaming when using Quick Tunnels.
3. **Cloudflare Named Tunnel / Custom Domain** (Production):
   - Base URL: `https://llm.yourdomain.com/v1`
   - Fully supports real-time bidirectional SSE streaming.

Verify that the endpoint responds:

```bash
curl -s "https://<your-endpoint>/v1/models"
```

---

## 4. Configuring the Self-Hosted Model in Relay

Relay supports self-hosted endpoints through its built-in OpenAI-compatible provider abstraction.

### Option A: Primary vLLM Environment Variables

Set the following in your local `.env`:

```dotenv
# Upstream base URL (must include /v1 prefix)
VLLM_BASE_URL=https://<your-endpoint>/v1

# Target model ID advertised by the backend
VLLM_MODEL=qwen2.5-coder-7b

# Optional: Context length limit (e.g. 4096, 8192, 16384)
VLLM_MAX_MODEL_LEN=16384

# Optional: Vision/Multimodal capability override (true/false)
VLLM_SUPPORTS_VISION=false

# Optional: API key if your server was started with --api-key
VLLM_API_KEY=your_optional_secret_key
```

### Option B: Generic OpenAI-Compatible Environment Variables

```dotenv
OPENAI_COMPATIBLE_BASE_URL=https://<your-endpoint>/v1
OPENAI_COMPATIBLE_MODELS=llama-3.1-8b
OPENAI_COMPATIBLE_NAME=self-hosted-llama
OPENAI_COMPATIBLE_API_KEY=
```

### Option C: Multi-Backend Provider Configuration (`ADDITIONAL_PROVIDERS`)

To configure multiple self-hosted endpoints or co-host several models across providers, define `ADDITIONAL_PROVIDERS` as a JSON array in `.env`:

```dotenv
ADDITIONAL_PROVIDERS='[
  {
    "id": "kaggle-qwen",
    "name": "Kaggle Qwen Coder",
    "baseUrl": "https://qwen-tunnel.trycloudflare.com/v1",
    "models": ["qwen2.5-coder-7b"],
    "supportsVision": false
  },
  {
    "id": "kaggle-smolvlm",
    "name": "Kaggle SmolVLM2",
    "baseUrl": "https://vlm-tunnel.trycloudflare.com/v1",
    "models": ["smolvlm2-2.2b"],
    "supportsVision": true
  }
]'
```

---

## 5. End-to-End Execution Example

Once configured and Relay is started (`pnpm dev` or `node apps/api/dist/server.js`):

### 1. Discover Registered Models

```bash
curl -s http://localhost:3000/v1/models | jq .
```

Output:

```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen2.5-coder-7b",
      "object": "model",
      "owned_by": "vllm",
      "capabilities": {
        "supportsStreaming": true,
        "supportsToolCalling": true,
        "supportsVision": false,
        "supportsStructuredOutput": true,
        "maxContextTokens": 16384,
        "maxOutputTokens": 4096
      }
    }
  ]
}
```

### 2. Send Chat Completion Through Relay

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5-coder-7b",
    "messages": [
      {"role": "system", "content": "You are a concise programming assistant."},
      {"role": "user", "content": "Write a quicksort in Python."}
    ],
    "temperature": 0.7
  }'
```

Relay routes the request to your self-hosted instance, applies configured rate limits and circuit breaker protections, normalizes any upstream errors, records telemetry metrics, and streams the response back to your client.
