import { isRetryableError } from '../routing/routing-policy.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerDecision {
  readonly allow: boolean;
  readonly state: CircuitState;
  readonly provider: string;
  readonly reason?: string | undefined;
  readonly retryAfterMs?: number | undefined;
}

export interface CircuitBreaker {
  /**
   * Evaluates if a request should be permitted for the given provider.
   */
  beforeRequest(providerId: string): CircuitBreakerDecision;

  /**
   * Records a successful request execution for the given provider.
   */
  onSuccess(providerId: string): void;

  /**
   * Records a failed request execution for the given provider.
   * If error is provided, only qualifying upstream failures advance the failure count.
   */
  onFailure(providerId: string, error?: unknown): void;

  /**
   * Returns the current circuit state for a provider.
   */
  getState(providerId: string): CircuitState;

  /**
   * Manually resets a provider's circuit state to closed, or all providers if omitted.
   */
  reset(providerId?: string): void;
}

export interface InMemoryCircuitBreakerOptions {
  readonly failureThreshold?: number | undefined;
  readonly resetTimeoutMs?: number | undefined;
  readonly halfOpenMaxRequests?: number | undefined;
  readonly getTime?: (() => number) | undefined;
}

/**
 * Checks if an error qualifies as a circuit-breaker tripping failure.
 * Qualifying errors: 502, 503, 504, connection drops, network errors, timeouts.
 * Non-qualifying errors: 400, 401, 429, context window exceeded, client cancellations.
 */
export function isCircuitBreakerFailure(error: unknown): boolean {
  return isRetryableError(error);
}

interface ProviderCircuitRecord {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt?: number | undefined;
  halfOpenAttempts: number;
}

export class InMemoryCircuitBreaker implements CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxRequests: number;
  private readonly getTime: () => number;
  private readonly circuits = new Map<string, ProviderCircuitRecord>();

  constructor(options: InMemoryCircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30000;
    this.halfOpenMaxRequests = options.halfOpenMaxRequests ?? 1;
    this.getTime = options.getTime ?? (() => Date.now());
  }

  private getRecord(providerId: string): ProviderCircuitRecord {
    let record = this.circuits.get(providerId);
    if (!record) {
      record = {
        state: 'closed',
        consecutiveFailures: 0,
        halfOpenAttempts: 0,
      };
      this.circuits.set(providerId, record);
    }
    return record;
  }

  private evaluateState(record: ProviderCircuitRecord): CircuitState {
    if (record.state === 'open') {
      const now = this.getTime();
      const openedAt = record.openedAt ?? now;
      if (now - openedAt >= this.resetTimeoutMs) {
        record.state = 'half_open';
        record.halfOpenAttempts = 0;
      }
    }
    return record.state;
  }

  public getState(providerId: string): CircuitState {
    const record = this.getRecord(providerId);
    return this.evaluateState(record);
  }

  public beforeRequest(providerId: string): CircuitBreakerDecision {
    const record = this.getRecord(providerId);
    const currentState = this.evaluateState(record);

    if (currentState === 'closed') {
      return {
        allow: true,
        state: 'closed',
        provider: providerId,
      };
    }

    if (currentState === 'open') {
      const now = this.getTime();
      const openedAt = record.openedAt ?? now;
      const retryAfterMs = Math.max(0, this.resetTimeoutMs - (now - openedAt));
      return {
        allow: false,
        state: 'open',
        provider: providerId,
        reason: `Circuit is open due to ${record.consecutiveFailures} consecutive failures.`,
        retryAfterMs,
      };
    }

    // currentState === 'half_open'
    if (record.halfOpenAttempts < this.halfOpenMaxRequests) {
      record.halfOpenAttempts++;
      return {
        allow: true,
        state: 'half_open',
        provider: providerId,
      };
    }

    return {
      allow: false,
      state: 'half_open',
      provider: providerId,
      reason: `Circuit is half-open and trial request limit (${this.halfOpenMaxRequests}) has been reached.`,
    };
  }

  public onSuccess(providerId: string): void {
    const record = this.getRecord(providerId);
    record.state = 'closed';
    record.consecutiveFailures = 0;
    record.halfOpenAttempts = 0;
    record.openedAt = undefined;
  }

  public onFailure(providerId: string, error?: unknown): void {
    if (error !== undefined && !isCircuitBreakerFailure(error)) {
      return;
    }

    const record = this.getRecord(providerId);
    const currentState = this.evaluateState(record);

    if (currentState === 'half_open') {
      // Any qualifying failure in half_open reopens the circuit immediately
      record.state = 'open';
      record.openedAt = this.getTime();
      record.halfOpenAttempts = 0;
      return;
    }

    record.consecutiveFailures++;
    if (record.consecutiveFailures >= this.failureThreshold) {
      record.state = 'open';
      record.openedAt = this.getTime();
      record.halfOpenAttempts = 0;
    }
  }

  public reset(providerId?: string): void {
    if (providerId) {
      this.circuits.delete(providerId);
    } else {
      this.circuits.clear();
    }
  }
}

export class NoopCircuitBreaker implements CircuitBreaker {
  public beforeRequest(providerId: string): CircuitBreakerDecision {
    return {
      allow: true,
      state: 'closed',
      provider: providerId,
    };
  }

  public onSuccess(_providerId: string): void {
    // No-op
  }

  public onFailure(_providerId: string, _error?: unknown): void {
    // No-op
  }

  public getState(_providerId: string): CircuitState {
    return 'closed';
  }

  public reset(_providerId?: string): void {
    // No-op
  }
}
