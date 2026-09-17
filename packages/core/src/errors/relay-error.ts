export interface OpenAIErrorShape {
  readonly message: string;
  readonly type: string;
  readonly code: string;
  readonly param: string | null;
  readonly details?: Record<string, unknown>;
}

export interface OpenAIErrorResponse {
  readonly error: OpenAIErrorShape;
}

export interface RelayErrorOptions {
  readonly cause?: unknown;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;
}

/**
 * Abstract base error for all Relay domain and gateway errors.
 * Ensures every error has a machine-readable code, appropriate HTTP status code,
 * and standard serialization methods.
 */
export abstract class RelayError extends Error {
  readonly isRelayError = true;
  abstract readonly code: string;
  abstract readonly statusCode: number;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(message: string, options?: RelayErrorOptions) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
    if (options?.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
    // Restore prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      ...(this.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: this.retryAfterSeconds }
        : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }

  toOpenAIError(): OpenAIErrorResponse {
    return {
      error: {
        message: this.message,
        type: this.code,
        code: this.code,
        param: null,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

/**
 * 400 Invalid Request: Request validation failed, missing parameters, or unparseable input.
 */
export class RelayInvalidRequestError extends RelayError {
  readonly code = 'invalid_request';
  readonly statusCode = 400;
}

/**
 * 401 Authentication Error: Missing or invalid API key / bearer token.
 */
export class RelayAuthenticationError extends RelayError {
  readonly code = 'authentication_error';
  readonly statusCode = 401;
}

/**
 * 429 Rate Limit Error: Upstream or local rate limit / quota exceeded.
 */
export class RelayRateLimitError extends RelayError {
  readonly code = 'rate_limit_exceeded';
  readonly statusCode = 429;
}

/**
 * 400 Context Window Exceeded: Input tokens exceed the model's supported context window.
 */
export class RelayContextWindowExceededError extends RelayError {
  readonly code = 'context_window_exceeded';
  readonly statusCode = 400;
}

/**
 * 504 Timeout Error: Upstream request or gateway execution deadline exceeded.
 */
export class RelayTimeoutError extends RelayError {
  readonly code = 'request_timeout';
  readonly statusCode = 504;
}

/**
 * 502/503 Provider Unavailable: Upstream provider is returning 5xx or unreachable.
 */
export class RelayProviderUnavailableError extends RelayError {
  readonly code = 'provider_unavailable';
  readonly statusCode: number;

  constructor(message: string, options?: RelayErrorOptions & { readonly statusCode?: 502 | 503 }) {
    super(message, options);
    this.statusCode = options?.statusCode ?? 502;
  }
}

/**
 * 499 Request Cancelled: Client aborted or closed the connection before completion.
 */
export class RelayRequestCancelledError extends RelayError {
  readonly code = 'cancelled';
  readonly statusCode = 499;
}

/**
 * Type guard to check if an unknown error is an instance of RelayError.
 */
export function isRelayError(error: unknown): error is RelayError {
  return (
    error instanceof RelayError ||
    (typeof error === 'object' &&
      error !== null &&
      'isRelayError' in error &&
      (error as { isRelayError: unknown }).isRelayError === true)
  );
}

/**
 * Type guard to check if an unknown error is a RelayRateLimitError.
 */
export function isRateLimitError(error: unknown): error is RelayRateLimitError {
  return (
    error instanceof RelayRateLimitError ||
    (isRelayError(error) && error.code === 'rate_limit_exceeded')
  );
}

/**
 * Type guard to check if an unknown error is a RelayRequestCancelledError.
 */
export function isRequestCancelledError(error: unknown): error is RelayRequestCancelledError {
  return (
    error instanceof RelayRequestCancelledError ||
    (isRelayError(error) && error.code === 'cancelled')
  );
}
