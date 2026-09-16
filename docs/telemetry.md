# Usage & Observability Telemetry

Relay includes a first-class, provider-agnostic telemetry foundation designed to capture normalized operational records for every inbound request without altering the OpenAI API contract or adding request latency.

---

## 1. Overview & Architecture

Every request passing through `/v1/chat/completions` (streaming, non-streaming, successful, or failed) produces a standardized `UsageRecord` emitted to a pluggable `UsageSink`:

```
           Fastify Request (chat.ts / app.ts)
                         │
                         ▼
                   [UsageRecord]
                         │
                         ▼
                     UsageSink
                         ├── InMemoryUsageSink (testing, local diagnostics)
                         ├── NoopUsageSink (disabled telemetry)
                         └── (Future) Persistent PostgreSQL / Supabase Sink
```

---

## 2. Telemetry Data Contract (`UsageRecord`)

Defined in `@relay/core`:

```typescript
export interface UsageRecord {
  readonly requestId: string; // Unique request identifier (from header or UUID)
  readonly provider: string; // Concrete executing provider ('gemini', 'qwen', etc.)
  readonly model: string; // Concrete model identifier executed
  readonly requestedModel?: string; // Original model alias or requested identifier
  readonly stream: boolean; // Whether the request was an SSE stream
  readonly startedAt: Date; // Timestamp when request processing began
  readonly durationMs: number; // Total processing time in milliseconds
  readonly statusCode: number; // HTTP status code returned to the client
  readonly success: boolean; // True if status is 2xx, false otherwise
  readonly promptTokens?: number; // Input token count (if reported by provider)
  readonly completionTokens?: number; // Generated token count (if reported by provider)
  readonly totalTokens?: number; // Total token count (if reported by provider)
  readonly errorCategory?: string; // Standardized error category ('request_timeout', 'cancelled', etc.)
  readonly attemptCount?: number; // Total provider candidates attempted (primary + fallbacks)
}
```

---

## 3. Privacy & Security Boundaries

To maintain strict data security and compliance, Relay enforces clean boundaries between telemetry and payload data:

### Persisted Metadata

- Request IDs and timestamps.
- Provider and model identifiers.
- Token counts (prompt, completion, total).
- Execution latency and HTTP status codes.
- Standardized error codes.
- Routing attempt counts.

### Strictly Excluded (Never Stored)

- **Zero Credentials**: API keys, bearer tokens, and `Authorization` headers are completely stripped.
- **Zero Prompt Content**: User messages, system instructions, and tool arguments are never stored in telemetry.
- **Zero Output Content**: Generated model text, completions, and streamed tokens are never stored in telemetry.

---

## 4. Pluggable Sinks (`UsageSink`)

The `UsageSink` contract decouples telemetry generation from the storage backend:

```typescript
export interface UsageSink {
  record(record: UsageRecord): Promise<void> | void;
}
```

### Built-in Implementations

1. **`InMemoryUsageSink`**:
   - Stores telemetry records in an in-memory array.
   - Provides inspection methods: `getRecords()` and `clear()`.
   - Default sink for development and automated integration tests.
2. **`NoopUsageSink`**:
   - Zero-overhead sink that discards all events.
   - Used when telemetry capture is intentionally disabled.

---

## 5. Early Failure & Lifecycle Hooks

Relay captures usage metrics across the complete request lifecycle:

1. **Chat Completion Route (`chat.ts`)**:
   - Records full token usage, latency, provider selection, and candidate fallback counts upon request completion or failure.
2. **Global Fallback Hook (`onResponse` in `app.ts`)**:
   - Catches early rejections that occur before the chat handler executes (e.g. HTTP 401 Unauthorized, HTTP 413 Payload Too Large, HTTP 429 Rate Limit Exceeded).
   - Guarantees that every request sent to `/v1/chat/completions` generates an observable telemetry event.

---

## 6. Failure Isolation

Telemetry persistence is strictly isolated from the critical request path:

- Telemetry recording occurs asynchronously.
- A failure or exception in a `UsageSink` **never** interrupts or fails an active client HTTP response.
- Sink errors are logged via structured Fastify logging with sanitization to prevent leaking sensitive context.

---

## 7. Roadmap: Persistent Storage

A dedicated, persistent PostgreSQL/Supabase storage sink is scheduled for the next development milestone, enabling:

- Persistent audit logs.
- Token spend and cost analytics.
- Long-term provider reliability dashboards.
- Automated data retention policies.
