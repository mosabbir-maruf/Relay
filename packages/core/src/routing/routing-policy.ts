import { RelayProviderUnavailableError, RelayTimeoutError } from '../errors/relay-error.js';

/**
 * Inbound request metadata presented to the routing policy engine.
 */
export interface RoutingRequest {
  /**
   * The requested model identifier (bare ID, qualified 'provider/model', or logical alias).
   */
  readonly requestedModel: string;
  /**
   * Optional provider hint (e.g. from header or prefix).
   */
  readonly providerHint?: string | undefined;
  /**
   * Optional policy metadata (e.g. streaming flag, priority, client tier).
   */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Concrete fallback target specification.
 */
export interface FallbackTarget {
  readonly provider: string;
  readonly model: string;
}

/**
 * Outcome of model routing resolution.
 */
export interface RoutingDecision {
  /**
   * The original model identifier requested by the client.
   */
  readonly requestedModel: string;
  /**
   * Primary provider ID to execute the request.
   */
  readonly provider: string;
  /**
   * Concrete model ID to be passed to the provider.
   */
  readonly model: string;
  /**
   * Ordered fallback targets to attempt if the primary fails with a retryable error.
   */
  readonly fallbacks?: readonly FallbackTarget[] | undefined;
}

/**
 * Configuration schema for an explicit model routing policy or alias.
 */
export interface ModelRoutingRule {
  /**
   * Logical model alias or model name (e.g. "fast-coder", "general-assistant").
   */
  readonly model: string;
  /**
   * Primary target (e.g. "qwen/qwen3-coder-30b" or "qwen3-coder-30b").
   */
  readonly primary: string;
  /**
   * Optional ordered list of fallback targets if the primary fails with a retryable error.
   */
  readonly fallbacks?: readonly string[] | undefined;
}

/**
 * Provider-agnostic routing policy interface.
 * Decouples model selection from gateway transport and provider implementations.
 */
export interface RoutingPolicy {
  resolve(request: RoutingRequest): RoutingDecision;
}

/**
 * Checks if an upstream error represents a retryable failure (e.g. network drops, 502, 503, 504).
 * Non-retryable errors (400, 401, 429, 499, cancellation) must NOT be retried.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof RelayProviderUnavailableError) {
    return true; // 502 or 503
  }
  if (error instanceof RelayTimeoutError) {
    return true; // 504
  }

  if (typeof error === 'object' && error !== null) {
    const err = error as { statusCode?: unknown; code?: unknown };
    if (typeof err.statusCode === 'number') {
      return err.statusCode === 502 || err.statusCode === 503 || err.statusCode === 504;
    }
    if (typeof err.code === 'string') {
      return (
        err.code === 'provider_unavailable' ||
        err.code === 'request_timeout' ||
        err.code === 'ECONNREFUSED' ||
        err.code === 'ENOTFOUND' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'UND_ERR_CONNECT_TIMEOUT'
      );
    }
    const errMsg = (err as { message?: unknown }).message;
    if (typeof errMsg === 'string' && errMsg.toLowerCase().includes('fetch failed')) {
      return true;
    }
  }

  return false;
}
