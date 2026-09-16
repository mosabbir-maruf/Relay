# Relay

> **One interface. Any model.**

Relay is a high-performance, provider-agnostic LLM gateway and control plane built with Node.js, TypeScript, and Fastify. It exposes a unified, standard OpenAI-compatible API (`/v1/chat/completions`, `/v1/models`) and routes requests to heterogeneous upstream model backends—including Google Gemini, self-hosted vLLM servers (e.g., Qwen3-Coder), and arbitrary OpenAI-compatible endpoints.

> [!NOTE]
> **Gateway, Not a Model**: Relay is not an LLM and does not train or host models internally. All inference runs inside your configured upstream providers or self-hosted GPU clusters. Relay serves as the resilience, routing, security, and observability layer sitting between your client applications and upstream inference engines.

```
                         Client (OpenAI SDK / HTTP)
                                     │
                                     ▼
                   ┌───────────────────────────────────┐
                   │               Relay               │
                   │    (Gateway & Control Plane)      │
                   └─────────────────┬─────────────────┘
                                     │
           ┌─────────────────────────┼─────────────────────────┐
           ▼                         ▼                         ▼
  ┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
  │  Google Gemini  │       │  Qwen3-Coder    │       │ OpenAI-Compatible│
  │  (Cloud API)    │       │  (vLLM Server)  │       │ (Ollama, vLLM)  │
  └─────────────────┘       └─────────────────┘       └─────────────────┘
```

---

## Why Relay?

- **Eliminate Provider Lock-in**: Decouple client applications from specific vendor SDKs. Switch between hosted cloud APIs (Gemini) and self-hosted open-weights models (Qwen, Llama on vLLM) with configuration changes alone.
- **Failover & High Availability**: Automatically retry transient upstream errors against secondary fallback models without failing client requests.
- **Circuit Breaker Protection**: Detect and isolate consistently failing providers to eliminate latency spikes and stop hammering downed backends.
- **Centralized Governance & Security**: Enforce Bearer token authentication, process-local rate limiting, SSRF safeguards, payload size limits, and zero credential leakage in a single control plane.
- **Unified Telemetry**: Capture normalized request durations, token counts, error categories, and attempt counts across all providers.

---

## Core Capabilities

- **Standard OpenAI API Ingress**:
  - `POST /v1/chat/completions` supporting both JSON responses and Server-Sent Events (SSE) streaming.
  - `GET /v1/models` listing all configured models with capability metadata (context window, tool calling, vision).
  - `GET /v1/models/:model` for single-model inspection.
  - `GET /health` with cached upstream connectivity probes (`?refresh=true` supported).
- **Supported Provider Integrations**:
  - **Google Gemini**: Native adapter supporting Gemini 2.5 Flash, Gemini 2.5 Pro, and latest models with vision, structured outputs, and function calling.
  - **Qwen3-Coder via vLLM**: Verified first-class configuration for self-hosted `qwen3-coder-30b`.
  - **OpenAI-Compatible Backends**: Generic adapter compatible with vLLM, Ollama, LM Studio, Groq, Together, DeepSeek, and OpenAI.
  - **Extensible Multi-Provider JSON**: Add arbitrary additional backends dynamically via `ADDITIONAL_PROVIDERS` without touching gateway code.
- **Collision-Safe Model Routing**:
  - **Exact Bare IDs**: Route unambiguous model names directly (e.g. `gemini-2.5-flash`).
  - **Qualified Identifiers**: Explicitly namespace colliding models across backends (e.g. `qwen/qwen3-coder-30b` vs `local-ollama/qwen3-coder-30b`).
  - **Logical Aliases**: Define business-tier aliases (e.g. `fast-coder`, `general-assistant`) that resolve cleanly to target models.
  - **Cycle & Loop Detection**: Detects and rejects circular alias definitions (`A -> B -> A`).
- **Resilience & Fallback Policies**:
  - **Selective Retry**: Retries transient upstream errors (502, 503, 504, connection drops) while failing fast on client errors (400, 401, 429).
  - **Streaming-Safe Fallback**: Retries fallback models if the primary fails before HTTP headers commit. Never corrupts streams by switching providers mid-generation.
  - **Global Timeout Budget**: All fallback attempts share a unified deadline (`REQUEST_TIMEOUT_MS`).
  - **Client Abort Propagation**: Cancelling a client request immediately signals upstream providers via `AbortSignal`, freeing GPU resources.
- **Circuit Breaker Foundation**:
  - Three-state state machine: `closed` $\to$ `open` $\to$ `half_open` $\to$ `closed`.
  - Trips when consecutive qualifying failures exceed a configurable threshold.
  - Bypasses open providers immediately, routing straight to configured fallbacks.
  - Limits concurrent probing during `half_open` health checks.
- **Traffic Protection & Security**:
  - Optional static Bearer token authentication (`RELAY_API_KEY`).
  - Fixed-window process-local rate limiter (`InMemoryRateLimiter`) with bounded memory and LRU key eviction.
  - SSRF protection preventing access to cloud metadata services (`169.254.169.254`) and unauthorized link-local addresses.
  - 10MB payload body limits and JSON parsing validation.
  - Strict credential hygiene: Bearer tokens, secrets, and raw prompts are excluded from logs and error shapes.
- **Usage & Observability Telemetry**:
  - Generates normalized `UsageRecord` metrics for every request (tokens, duration, provider, status, error code, attempts).
  - Pluggable `UsageSink` abstraction (`InMemoryUsageSink`, `NoopUsageSink`).

---

## Architecture

Relay enforces an inward dependency rule across its monorepo packages. Core domain contracts have zero external runtime dependencies.

```
┌─────────────────────────────────────────────────────────────┐
│                          apps/api                           │
│  Fastify HTTP Server, Ingress Routes, Auth & Rate Limiting  │
│  Hooks, Zod Configuration Schema, SSE Writer, CLI Process   │
└──────────────┬───────────────────────────────┬──────────────┘
               │                               │
               ▼                               │
┌──────────────────────────────┐               │
│      @relay/providers        │               │
│  Gemini & OpenAI Adapters,   │               │
│  ProviderRegistry, Router,   │               │
│  SSE Parser, Error Mappers   │               │
└──────────────┬───────────────┘               │
               │                               │
               ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│                        @relay/core                          │
│  Domain Types, Normalized Error Hierarchy, Provider Specs,  │
│  RateLimiter Contract & In-Memory Limiter, CircuitBreaker   │
│  Contract & State Machine, UsageRecord & UsageSink Specs    │
│                 (Zero Runtime Dependencies)                 │
└─────────────────────────────────────────────────────────────┘
```

See [docs/architecture.md](docs/architecture.md) for detailed lifecycle sequences and component diagrams.

---

## Quick Start

### Prerequisites

- **Node.js**: `v20.0.0` or newer (v22+ recommended).
- **pnpm**: `v9.0.0` or newer.

### 1. Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/mosabbir-maruf/Relay.git
cd Relay
pnpm install
```

### 2. Environment Configuration

Copy the example environment configuration:

```bash
cp .env.example .env
```

Edit `.env` with your provider keys or local inference endpoints:

```dotenv
# Port and Server
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info

# Gateway Authentication (optional, leave blank for local development)
RELAY_API_KEY=

# Google Gemini (Optional)
GEMINI_API_KEY=your_gemini_api_key_here

# Qwen / Local vLLM Server (Optional)
QWEN_BASE_URL=http://localhost:8000/v1
QWEN_MODEL=qwen3-coder-30b
```

### 3. Run Development Server

```bash
pnpm dev
```

The gateway will start at `http://localhost:3000`.

### 4. Run Test Suite & Build

```bash
# Run all unit and integration tests (175 tests)
pnpm test

# Check code formatting
pnpm run format:check

# Run linter
pnpm run lint

# Run strict TypeScript check across all packages
pnpm run typecheck

# Build all packages for production
pnpm build
```

---

## Environment Configuration

Configuration is validated at startup using Zod. The primary configuration options in `.env` are:

| Variable                            |   Type    |                   Default                   | Description                                                                       |
| :---------------------------------- | :-------: | :-----------------------------------------: | :-------------------------------------------------------------------------------- |
| `PORT`                              | `number`  |                   `3000`                    | HTTP port for the Fastify server.                                                 |
| `HOST`                              | `string`  |                  `0.0.0.0`                  | Network binding interface.                                                        |
| `LOG_LEVEL`                         | `string`  |                   `info`                    | Logging verbosity (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`). |
| `REQUEST_TIMEOUT_MS`                | `number`  |                   `60000`                   | Global request deadline in milliseconds.                                          |
| `RELAY_API_KEY`                     | `string`  |                   _empty_                   | If set, all `/v1/*` endpoints require `Authorization: Bearer <token>`.            |
| `GEMINI_API_KEY`                    | `string`  |                   _empty_                   | Google Gemini API key. Activates the Gemini provider when set.                    |
| `GEMINI_BASE_URL`                   | `string`  | `https://generativelanguage.googleapis.com` | Gemini API root URL.                                                              |
| `GEMINI_MODELS`                     | `string`  |           `gemini-2.5-flash,...`            | Comma-separated model IDs to register under Gemini.                               |
| `QWEN_BASE_URL`                     | `string`  |                   _empty_                   | Endpoint URL for self-hosted Qwen vLLM backend (e.g. `http://localhost:8000/v1`). |
| `QWEN_MODEL`                        | `string`  |              `qwen3-coder-30b`              | Model name exposed by the Qwen vLLM backend.                                      |
| `QWEN_API_KEY`                      | `string`  |                   _empty_                   | Optional API key for the Qwen backend.                                            |
| `OPENAI_COMPATIBLE_BASE_URL`        | `string`  |                   _empty_                   | Generic OpenAI-compatible endpoint URL (e.g. `http://localhost:11434/v1`).        |
| `OPENAI_COMPATIBLE_MODELS`          | `string`  |                   _empty_                   | Comma-separated list of models available on the generic backend.                  |
| `ADDITIONAL_PROVIDERS`              | `string`  |                   _empty_                   | JSON array of extra OpenAI-compatible backends.                                   |
| `ROUTING_POLICIES`                  | `string`  |                   _empty_                   | JSON array of logical aliases and fallback chains.                                |
| `RATE_LIMIT_ENABLED`                | `boolean` |                   `false`                   | Enable or disable process-local rate limiting.                                    |
| `RATE_LIMIT_MAX_REQUESTS`           | `number`  |                    `100`                    | Max requests per key per window.                                                  |
| `RATE_LIMIT_WINDOW_MS`              | `number`  |                   `60000`                   | Rate limit window in milliseconds (1 minute).                                     |
| `CIRCUIT_BREAKER_ENABLED`           | `boolean` |                   `false`                   | Enable or disable upstream circuit breaking.                                      |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | `number`  |                     `5`                     | Consecutive failures before tripping a provider circuit to `open`.                |
| `CIRCUIT_BREAKER_RESET_TIMEOUT_MS`  | `number`  |                   `30000`                   | Cooldown period before probing a failing provider in `half_open` state.           |

---

## API Examples

All examples assume Relay is running on `http://localhost:3000`.

### 1. Health & Upstream Connectivity Check

```bash
curl -X GET http://localhost:3000/health
```

**Response**:

```json
{
  "status": "healthy",
  "timestamp": "2026-09-17T04:00:00.000Z",
  "providers": {
    "gemini": {
      "isHealthy": true,
      "latencyMs": 145,
      "lastChecked": "2026-09-17T03:59:50.000Z"
    },
    "qwen": {
      "isHealthy": true,
      "latencyMs": 12,
      "lastChecked": "2026-09-17T03:59:50.000Z"
    }
  }
}
```

### 2. Discover Models

```bash
curl -X GET http://localhost:3000/v1/models
```

**Response**:

```json
{
  "object": "list",
  "data": [
    {
      "id": "gemini-2.5-flash",
      "object": "model",
      "created": 1726500000,
      "owned_by": "gemini",
      "capabilities": {
        "supportsStreaming": true,
        "supportsToolCalling": true,
        "supportsVision": true,
        "supportsStructuredOutput": true,
        "maxContextTokens": 1048576,
        "maxOutputTokens": 8192
      }
    },
    {
      "id": "qwen3-coder-30b",
      "object": "model",
      "created": 1726500000,
      "owned_by": "qwen",
      "capabilities": {
        "supportsStreaming": true,
        "supportsToolCalling": true,
        "supportsVision": false,
        "supportsStructuredOutput": true,
        "maxContextTokens": 32768,
        "maxOutputTokens": 4096
      }
    }
  ]
}
```

### 3. Non-Streaming Chat Completion

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "Explain circuit breakers in one sentence." }
    ],
    "temperature": 0.7
  }'
```

**Response**:

```json
{
  "id": "chatcmpl-9abc123",
  "object": "chat.completion",
  "created": 1726500000,
  "model": "gemini-2.5-flash",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "A circuit breaker automatically stops routing requests to a failing service to prevent cascading failures."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 24,
    "completion_tokens": 19,
    "total_tokens": 43
  }
}
```

### 4. Streaming SSE Chat Completion

```bash
curl -N -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder-30b",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Write a TypeScript function to check for primes." }
    ]
  }'
```

**SSE Stream Output**:

```text
data: {"id":"chatcmpl-stream-1","object":"chat.completion.chunk","created":1726500000,"model":"qwen3-coder-30b","choices":[{"index":0,"delta":{"role":"assistant","content":"function"},"finish_reason":null}]}

data: {"id":"chatcmpl-stream-1","object":"chat.completion.chunk","created":1726500000,"model":"qwen3-coder-30b","choices":[{"index":0,"delta":{"content":" isPrime(n: number)"},"finish_reason":null}]}

data: [DONE]
```

---

## Model Aliases & Fallbacks

Relay allows defining stable logical model aliases and fallback chains via `ROUTING_POLICIES`:

```json
[
  {
    "model": "code-assistant",
    "primary": "qwen/qwen3-coder-30b",
    "fallbacks": ["gemini/gemini-2.5-flash"]
  }
]
```

When a client sends:

```json
{
  "model": "code-assistant",
  "messages": [{ "role": "user", "content": "Refactor this function" }]
}
```

1. Relay checks the circuit breaker for `qwen`. If healthy, it attempts `qwen3-coder-30b`.
2. If `qwen` fails with an upstream 502, 503, 504, or network timeout, Relay records the failure on the circuit breaker and transparently invokes the fallback `gemini/gemini-2.5-flash`.
3. The client receives a successful response, with `"model": "code-assistant"` preserved in the envelope.
4. If `qwen` is already `open` due to prior consecutive failures, Relay skips `qwen` entirely and routes directly to Gemini.

See [docs/routing-and-fallbacks.md](docs/routing-and-fallbacks.md) for full configuration details.

---

## Self-hosted Qwen / vLLM on Kaggle

Relay includes first-class support for self-hosted Qwen models running through vLLM on dual NVIDIA Tesla T4 GPUs (such as Kaggle's free GPU tier).

- **Canonical Deployment Runbook**: [docs/kaggle-qwen.md](docs/kaggle-qwen.md)
- **Executable Notebook**: [notebooks/qwen-vllm-kaggle.ipynb](notebooks/qwen-vllm-kaggle.ipynb)
- **Infrastructure Scripts**: [infra/kaggle/](infra/kaggle/) (`qwen-vllm.sh`, `cloudflared.sh`, `diagnostics.sh`)
- **Verified Serving**: `vllm serve QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ --served-model-name qwen3-coder-30b`
- **Relay Configuration**: Set `QWEN_BASE_URL=https://<tunnel-subdomain>.trycloudflare.com/v1` and `QWEN_MODEL=qwen3-coder-30b` in your local `.env`.

---

## Repository Structure

```
Relay/
├── apps/
│   └── api/                  # Fastify HTTP gateway application
│       ├── src/
│       │   ├── config/       # Environment schema and Zod validation
│       │   ├── hooks/        # Auth, rate-limiting, and request ID hooks
│       │   ├── routes/       # /health, /v1/models, /v1/chat/completions
│       │   ├── sse/          # Server-Sent Events stream writer
│       │   └── app.ts        # Fastify app factory
│       └── tests/            # End-to-end gateway integration tests
├── packages/
│   ├── core/                 # Core domain contracts, errors, rate limiter, breaker
│   │   ├── src/
│   │   │   ├── circuit-breaker/ # State machine and in-memory breaker
│   │   │   ├── errors/          # Normalized RelayError hierarchy
│   │   │   ├── rate-limiting/   # RateLimiter contract and fixed-window limiter
│   │   │   ├── routing/         # RoutingPolicy contract and error classifiers
│   │   │   └── telemetry/       # UsageRecord and UsageSink interfaces
│   │   └── tests/            # Pure unit tests for core primitives
│   └── providers/            # Upstream provider implementations
│       ├── src/
│       │   ├── gemini/          # Google Gemini provider adapter
│       │   ├── openai-compatible/ # Generic OpenAI & vLLM provider adapter
│       │   ├── registry/        # ProviderRegistry
│       │   └── routing/         # ModelRouter and alias resolution engine
│       └── tests/            # Provider and router test suite
├── infra/
│   └── kaggle/               # Reusable Kaggle deployment and diagnostic scripts
├── notebooks/
│   └── qwen-vllm-kaggle.ipynb # Canonical executable Kaggle deployment runbook
├── docs/                     # Technical architecture and feature documentation
├── LICENSE                   # MIT License
└── package.json              # Monorepo workspace configuration
```

---

## Documentation Index

- [Architecture Overview](docs/architecture.md): Lifecycle diagrams, package layering, and design principles.
- [Self-Hosted Qwen/vLLM on Kaggle](docs/kaggle-qwen.md): Complete deployment runbook and verified configuration for dual T4 GPUs.
- [Model Routing, Aliases & Fallbacks](docs/routing-and-fallbacks.md): Policy configuration, cycle detection, and fallback mechanics.
- [Circuit Breaker Foundation](docs/circuit-breaker.md): State transitions, thresholds, and failure classification.
- [Rate Limiting](docs/rate-limiting.md): Fixed-window algorithm, keying strategies, headers, and memory limits.
- [OpenAI-Compatible & vLLM Setup](docs/openai-compatible-setup.md): Generic backend configuration, multi-provider JSON, and server setups.
- [Usage & Observability Telemetry](docs/telemetry.md): Telemetry data contract, sinks, and privacy boundaries.

---

## Current Limitations

Relay is deliberately designed with minimal external dependencies. Current architectural boundaries include:

- **Process-Local Rate Limiting**: The built-in rate limiter is in-memory. Counters reset on process restart and operate per-process across multi-instance clusters.
- **Process-Local Circuit Breaker**: Circuit state is tracked within each gateway process; distributed circuit state synchronization is not yet implemented.
- **Static Routing Policies**: Model aliases and fallback chains are loaded from configuration at startup. Dynamic runtime database updates are not yet supported.
- **In-Memory Telemetry**: The default `InMemoryUsageSink` retains records in process memory. Persistent storage is scheduled for the upcoming milestone.
- **Deterministic Routing**: Fallback policies are priority-ordered; dynamic latency or cost-based routing heuristics are not yet implemented.

---

## Roadmap

- [ ] **PostgreSQL & Supabase Usage Persistence**: Durable storage adapter for `UsageRecord` telemetry.
- [ ] **Cost Calculation & Spend Estimation**: Automated token pricing and cost modeling per model.
- [ ] **Telemetry Query APIs**: Auditing, token usage aggregation, and operational analytics endpoints.
- [ ] **Distributed Rate Limiting**: Optional Redis-backed rate limiter adapter.
- [ ] **Web Administration Dashboard**: Visual inspection of providers, circuit states, and real-time request metrics.

---

## License

Relay is open-source software licensed under the [MIT License](LICENSE).
