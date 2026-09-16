# Model Routing, Aliases & Fallbacks

Relay provides a production-oriented, policy-driven model routing layer that decouples incoming model requests from concrete provider execution.

---

## 1. Resolution Modes

### A. Exact Unambiguous Model Routing

Clients can request bare registered model identifiers directly:

```json
{
  "model": "qwen3-coder-30b",
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

If the model ID is registered under exactly one provider in `ProviderRegistry`, Relay routes directly to that provider without modification.

### B. Qualified Provider Routing (`<provider>/<modelId>`)

To explicitly target a specific provider or resolve bare model name collisions:

```json
{
  "model": "qwen/qwen3-coder-30b",
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

If multiple backends register the same bare name (e.g. two providers both expose `llama-3`), Relay flags the bare name as ambiguous and requires clients to use the qualified identifier.

### C. Logical Model Aliases

Operators can define stable, logical model aliases via the `ROUTING_POLICIES` configuration:

```json
[
  {
    "model": "fast-coder",
    "primary": "qwen/qwen3-coder-30b",
    "fallbacks": ["gemini/gemini-2.5-flash"]
  }
]
```

Clients can then request:

```json
{
  "model": "fast-coder",
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

Relay resolves `"fast-coder"` through the routing layer to the concrete target while echoing the requested alias in the OpenAI response envelope.

---

## 2. Fallback Execution & Retry Rules

When a primary provider encounters a failure, Relay evaluates whether the error is eligible for fallback execution.

### Retryable Errors (Eligible for Fallback)

Fallback is attempted if and only if the failure is transient and upstream-related:

- **Connection Failures**: `ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, or network fetch drops.
- **Upstream 502 Bad Gateway**: Upstream proxy or server down (`RelayProviderUnavailableError`).
- **Upstream 503 Service Unavailable**: Temporary capacity exhaustion or maintenance.
- **Upstream 504 Gateway Timeout**: Upstream inference deadline exceeded (`RelayTimeoutError`).

### Non-Retryable Errors (Never Retried)

Relay **never** retries errors caused by invalid client inputs or non-transient conditions:

- **400 Invalid Request**: Validation errors, malformed request bodies, schema errors (`RelayInvalidRequestError`).
- **400 Context Window Exceeded**: Prompt exceeds model limits (`RelayContextWindowExceededError`).
- **401 Authentication Error**: Invalid or missing provider API keys (`RelayAuthenticationError`).
- **429 Rate Limit Exceeded**: Quota rejections (local or upstream) are surfaced immediately to prevent quota churning.
- **499 Client Cancellation**: Client socket disconnects or explicitly cancels the request.

---

## 3. Streaming Fallback Behavior

- **Before First Chunk**: If a streaming provider fails before emitting any SSE chunks (e.g., connection refused or immediate 502 before HTTP headers are committed), Relay catches the failure and smoothly attempts the next configured fallback candidate.
- **Mid-Stream Failures (No Silent Switching)**: Once the first SSE chunk is delivered to the client, HTTP 200 headers have been committed and the connection is active. If the upstream provider disconnects mid-stream, Relay **does not** switch providers (which would produce incoherent text streams). Instead, it emits a standardized OpenAI SSE error chunk (`data: {"error": {"message": ..., "type": "stream_error"}}\n\n`) and terminates the stream cleanly.

---

## 4. Loop Prevention & Retry Safety

- **Alias Cycle Detection**: If aliases create a cycle (e.g. `A -> B -> A` or `A -> A`), Relay detects the loop at resolution time and rejects the request with HTTP 400 (`RelayInvalidRequestError`).
- **Deduplication**: If a fallback targets the same provider and model as the primary, or appears multiple times in the fallback list, duplicate targets are removed.
- **Strict Attempt Bounds**: Fallback candidates are strictly limited to a maximum of 3 targets (up to 4 total attempts).
- **Timeout Budget**: All attempts share the single global `REQUEST_TIMEOUT_MS` deadline. If the overall budget expires during any attempt, execution immediately aborts with HTTP 504.
- **Rate Limit Safety**: Fallback attempts are internal to a single inbound request; the client's rate-limit bucket is decremented only once upon ingress.
