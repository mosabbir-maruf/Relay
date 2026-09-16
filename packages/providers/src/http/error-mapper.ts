import {
  RelayAuthenticationError,
  RelayError,
  RelayInvalidRequestError,
  RelayProviderUnavailableError,
  RelayRateLimitError,
  RelayTimeoutError,
} from '@relay/core';

export interface UpstreamErrorContext {
  readonly provider: string;
  readonly status: number;
  readonly statusText: string;
  readonly bodyText?: string;
  readonly retryAfterHeader?: string | null;
}

/**
 * Normalizes any HTTP error status and raw upstream body from an LLM provider
 * into a strongly-typed RelayError subclass.
 */
export function mapHttpStatusToRelayError(context: UpstreamErrorContext): RelayError {
  const { provider, status, statusText, bodyText, retryAfterHeader } = context;
  let parsedDetails: Record<string, unknown> | undefined;

  if (bodyText) {
    try {
      const json = JSON.parse(bodyText) as Record<string, unknown>;
      parsedDetails = { provider, ...json };
    } catch {
      parsedDetails = { provider, rawBody: bodyText };
    }
  } else {
    parsedDetails = { provider, statusText };
  }

  // Parse retry-after header if present (in seconds)
  let retryAfterSeconds: number | undefined;
  if (retryAfterHeader) {
    const parsed = parseInt(retryAfterHeader, 10);
    if (!isNaN(parsed) && parsed > 0) {
      retryAfterSeconds = parsed;
    }
  }

  const message =
    extractErrorMessage(parsedDetails) ??
    `Upstream provider "${provider}" returned HTTP ${status}: ${statusText}`;

  switch (status) {
    case 400:
      return new RelayInvalidRequestError(message, { details: parsedDetails });
    case 401:
    case 403:
      return new RelayAuthenticationError(message, { details: parsedDetails });
    case 404:
      return new RelayInvalidRequestError(
        `Model or resource not found on provider "${provider}": ${message}`,
        {
          details: parsedDetails,
        },
      );
    case 429:
      return new RelayRateLimitError(message, {
        details: parsedDetails,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      });
    case 504:
      return new RelayTimeoutError(message, { details: parsedDetails });
    case 502:
    case 503:
    default:
      return new RelayProviderUnavailableError(message, {
        statusCode: status === 503 ? 503 : 502,
        details: parsedDetails,
      });
  }
}

/**
 * Helper to safely extract error message from standard provider error structures.
 */
function extractErrorMessage(details?: Record<string, unknown>): string | undefined {
  if (!details) return undefined;

  // OpenAI format: { error: { message: "..." } }
  if (typeof details['error'] === 'object' && details['error'] !== null) {
    const errObj = details['error'] as Record<string, unknown>;
    if (typeof errObj['message'] === 'string' && errObj['message'].length > 0) {
      return errObj['message'];
    }
  }

  // Gemini / Google format: { error: { message: "...", status: "..." } } or array
  if (typeof details['message'] === 'string' && details['message'].length > 0) {
    return details['message'];
  }

  return undefined;
}
