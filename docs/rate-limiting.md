# Relay Rate Limiting Foundation

Relay includes a high-performance, provider-agnostic rate limiting foundation designed to protect the gateway process and upstream model inference backends from accidental burst floods and abusive traffic.

---

## 1. Architectural Design & Limiter Contract

Rate limiting is decoupled from the gateway transport and specific storage layers via the `RateLimiter` contract in `@relay/core`:

```typescript
export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly limit: number;
  readonly retryAfterSeconds?: number;
  readonly resetAt?: number; // epoch ms when window resets
}

export interface RateLimitInput {
  readonly key: string;
  readonly cost?: number; // default: 1
}

export interface RateLimiter {
  check(input: RateLimitInput): Promise<RateLimitDecision> | RateLimitDecision;
  reset?(key?: string): Promise<void> | void;
  destroy?(): Promise<void> | void;
}
```

### In-Memory Fixed-Window Implementation (`InMemoryRateLimiter`)

The default provider is `InMemoryRateLimiter`:

- **Algorithm**: Fixed window with reset. Each key tracks `count` and `resetAt`. When the window expires, quota resets cleanly.
- **Bounded Memory Footprint**: Strictly limits tracked keys to `maxKeys` (default: 10,000 keys, occupying ~1MB of RAM).
- **Eviction Strategy**: On capacity overflow, expired keys are swept first. If still over limit, least-recently-used (LRU) keys are evicted.
- **Atomic Concurrency**: Operates synchronously within Node.js's single-threaded event loop, avoiding race conditions without lock contention.

---

## 2. Configuration Options

Configure rate limiting via environment variables in `.env`:

| Variable                  |   Type    |    Default     | Description                                                                              |
| :------------------------ | :-------: | :------------: | :--------------------------------------------------------------------------------------- |
| `RATE_LIMIT_ENABLED`      | `boolean` |    `false`     | Enable or disable rate limiting on the gateway                                           |
| `RATE_LIMIT_WINDOW_MS`    | `number`  |    `60000`     | Rate limit window duration in milliseconds (e.g. 60,000 = 1 minute)                      |
| `RATE_LIMIT_MAX_REQUESTS` | `number`  |     `100`      | Maximum requests permitted per key within the window                                     |
| `RATE_LIMIT_KEY_STRATEGY` | `string`  | `client_or_ip` | Key strategy: `client_or_ip`, `client_only`, or `ip_only`                                |
| `RATE_LIMIT_MAX_KEYS`     | `number`  |    `10000`     | Hard cap on tracked identities in memory to prevent exhaustion                           |
| `TRUST_PROXY`             | `boolean` |    `false`     | Trust reverse proxy headers (`X-Forwarded-For`). Default `false` ignores spoofed headers |

---

## 3. Keying & Identity Strategies

1. **`client_or_ip` (Default)**:
   - If the request includes a valid `Authorization: Bearer <token>`, the token is hashed using SHA-256 (`client:<sha256-prefix>`).
   - If no credentials are present, the request falls back to the client IP address (`ip:<ip>`).
2. **`client_only`**:
   - Keys strictly on the client token. Falls back to IP if unauthenticated.
3. **`ip_only`**:
   - Always keys on client IP address regardless of credentials.

### Zero Credential Leakage

Raw tokens and secrets are never stored in the limiter map, logs, or error payloads. All bearer tokens are cryptographically digested before being evaluated.

---

## 4. HTTP Headers & Error Responses

### Standard Headers

Every evaluated request emits standard rate-limit headers:

- `x-ratelimit-limit`: Total request limit within the current window.
- `x-ratelimit-remaining`: Number of remaining requests in the active window.
- `x-ratelimit-reset`: Unix timestamp (seconds) when the active window resets.

### 429 Rate Limit Exceeded Response

When a client exceeds their allowance, Relay immediately terminates the request with HTTP 429 before invoking upstream provider logic or allocating streaming buffers:

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json; charset=utf-8
x-ratelimit-limit: 100
x-ratelimit-remaining: 0
x-ratelimit-reset: 1773715200
retry-after: 35

{
  "error": {
    "message": "Rate limit exceeded. Please retry after 35 seconds.",
    "type": "rate_limit_exceeded",
    "code": "rate_limit_exceeded",
    "param": null,
    "details": {
      "limit": 100,
      "remaining": 0,
      "retryAfterSeconds": 35
    }
  }
}
```

---

## 5. Excluded Endpoints

- **`/health`**: Operational readiness probes and uptime checks are explicitly exempt from rate limiting to prevent orchestrator (Kubernetes, AWS ECS) health check failures during high-traffic periods.

---

## 6. Scope, State & Deferred Distributed Storage

> [!IMPORTANT]
> **Process-Local Scope**:
> The `InMemoryRateLimiter` operates in-memory within a single Node.js process.
>
> - **Process Restart**: When the Relay gateway restarts or a deployment rolls over, rate limit buckets reset to zero.
> - **Multi-Instance Deployments**: When scaling Relay horizontally across multiple pods/containers without a sticky session load balancer, each instance enforces its own rate limit independently.

### Why Redis / External Distributed Storage is Deferred

1. **Zero External Dependencies**: Relay can be deployed as a single self-contained binary/container without requiring a stateful Redis cluster or managed cloud cache.
2. **Minimal Latency Overhead**: In-memory Map lookups execute in sub-microsecond time ($\approx 0.05\mu s$), avoiding network hops and serialization penalties.
3. **Pluggable Architecture**: The `RateLimiter` interface is storage-agnostic. A distributed `RedisRateLimiter` can be added in the future by implementing the `RateLimiter` contract without modifying any gateway route handlers, hooks, or provider adapters.
