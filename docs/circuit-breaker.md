# Circuit Breaker Foundation

Relay includes a provider-agnostic, in-memory **Circuit Breaker** foundation designed to protect upstream LLM providers during outages, avoid cascade failures, and optimize latency by immediately skipping broken providers in fallback chains.

---

## 1. Overview & Architecture

When an upstream LLM provider (e.g. self-hosted vLLM or remote cloud API) becomes unavailable, repeatedly attempting requests against it causes:

- Excessive latency (waiting for connection timeouts).
- Resource exhaustion on the gateway and upstream.
- Poor client experience when a viable fallback provider is configured.

The Relay Circuit Breaker tracks consecutive failures per provider and manages state transitions:

```
                  ┌────────────────────────┐
                  │                        │
       ┌─────────►│         CLOSED         │◄────────┐
       │          │ (Requests Pass-Through)│         │
       │          │                        │         │
       │          └───────────┬────────────┘         │
       │                      │                      │
       │             failureThreshold                │
       │             failures reached                │
       │                      │                      │
       │                      ▼                      │
       │          ┌────────────────────────┐         │
Trial request     │                        │         │
  succeeds        │          OPEN          │         │
       │          │ (Fast-Fail / Fallback) │         │
       │          │                        │         │
       │          └───────────┬────────────┘         │
       │                      │                      │
       │                resetTimeoutMs               │
       │                   elapsed                   │
       │                      │                      │
       │                      ▼                      │
       │          ┌────────────────────────┐         │
       │          │                        │         │
       └──────────┤       HALF_OPEN        │         │
                  │ (Trial Request Probing)│─────────┘
                  │                        │ Trial request
                  └────────────────────────┘    fails
```

---

## 2. State Machine

| State         | Behavior                                                                                                                                                                                                   | Next Transition                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CLOSED**    | All requests are forwarded to the provider normally. Consecutive failures are counted.                                                                                                                     | Transitions to **OPEN** once consecutive qualifying failures reach `CIRCUIT_BREAKER_FAILURE_THRESHOLD`.                                                                       |
| **OPEN**      | Requests to the provider are immediately rejected. If a fallback provider is configured in `ModelRouter`, Relay skips the primary directly to the fallback without touching the primary.                   | Transitions to **HALF_OPEN** once `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` has elapsed.                                                                                             |
| **HALF_OPEN** | A limited number of trial requests (`CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS`, default 1) are permitted to probe the provider's health. Concurrent requests exceeding the trial limit are skipped/rejected. | If the trial request succeeds, transitions to **CLOSED** (failures reset to 0). If the trial request fails with a qualifying error, transitions immediately back to **OPEN**. |

---

## 3. Failure Classification

Relay distinguishes between **upstream availability failures** (which trip the breaker) and **client or application errors** (which do not trip the breaker).

### Qualifying Failures (Trip Circuit)

- HTTP 502 Bad Gateway
- HTTP 503 Service Unavailable
- HTTP 504 Gateway Timeout / Deadline Exceeded
- Network drops & socket failures: `ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, `ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`, `fetch failed`
- Normalized `RelayProviderUnavailableError` and `RelayTimeoutError`

### Non-Qualifying Failures (Never Trip Circuit)

- HTTP 400 Bad Request / `RelayInvalidRequestError` (e.g. malformed JSON, prompt issues)
- HTTP 401 Unauthorized / `RelayAuthenticationError`
- HTTP 429 Too Many Requests / `RelayRateLimitError` (client or upstream quota limit)
- Context window exceeded (`RelayContextWindowExceededError`)
- Client cancellations (`499`, socket close, or client abort signals)

---

## 4. Integration with Model Router & Fallbacks

The Circuit Breaker integrates cleanly with the `ModelRouter` candidate loop:

1. **Direct Fallback Bypass**:
   If the primary candidate's circuit is OPEN, Relay logs a warning and skips directly to the fallback target. The primary is not contacted, saving connection latency and preventing load on the struggling provider.
2. **All Candidates Open**:
   If all configured candidates (primary + fallbacks) are OPEN or fail, Relay returns an OpenAI-compatible HTTP 503 Service Unavailable error (`code: "provider_unavailable"`).
3. **Single Rate Limit Charge**:
   Rate limiting is enforced at the gateway ingress level (`preHandler`) before model routing. Skipping an open provider or executing a fallback does **not** charge extra rate limit tokens to the client.
4. **Streaming Protection**:
   Pre-stream failures (before HTTP headers commit) advance the provider failure count and trigger fallback. Mid-stream failures record a failure against the circuit breaker without corrupting the active SSE response.

---

## 5. Configuration

Enable and tune the circuit breaker via environment variables:

```env
# Enable the process-local in-memory circuit breaker
CIRCUIT_BREAKER_ENABLED=true

# Number of consecutive qualifying failures required to trip the breaker (default: 5)
CIRCUIT_BREAKER_FAILURE_THRESHOLD=5

# Cooldown period before transitioning from OPEN to HALF_OPEN (default: 30000 ms)
CIRCUIT_BREAKER_RESET_TIMEOUT_MS=30000

# Maximum number of concurrent trial requests permitted in HALF_OPEN state (default: 1)
CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS=1
```

When `CIRCUIT_BREAKER_ENABLED=false` (the default), `NoopCircuitBreaker` is utilized, preserving exact passthrough behavior.
