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
 * Strips known credential patterns and caps length to ensure sensitive data
 * (API keys, authorization headers, tokens) is never leaked in error messages.
 */
function sanitizeErrorMessage(msg: string): string {
  if (!msg) return '';
  return msg
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key[:=\s]+)[A-Za-z0-9._~-]+/gi, '$1[REDACTED]')
    .replace(/(AIza[0-9A-Za-z-_]{20,})/g, '[REDACTED]')
    .replace(/(sk-[a-zA-Z0-9_-]{20,})/g, '[REDACTED]')
    .slice(0, 500);
}

/**
 * Normalizes any HTTP error status and raw upstream body from an LLM provider
 * into a strongly-typed RelayError subclass with safe, allowlisted details.
 *
 * Never exposes raw upstream response bodies, authorization headers, or sensitive
 * credentials to the client.
 */
export function mapHttpStatusToRelayError(context: UpstreamErrorContext): RelayError {
  const { provider, status, statusText, bodyText, retryAfterHeader } = context;

  let rawExtractedMessage: string | undefined;
  let providerCode: string | undefined;
  let providerType: string | undefined;

  if (bodyText) {
    try {
      const json = JSON.parse(bodyText) as Record<string, unknown>;
      if (typeof json['error'] === 'object' && json['error'] !== null) {
        const errObj = json['error'] as Record<string, unknown>;
        if (typeof errObj['message'] === 'string') {
          rawExtractedMessage = errObj['message'];
        }
        if (typeof errObj['status'] === 'string') {
          providerCode = errObj['status'];
        } else if (typeof errObj['code'] === 'string' || typeof errObj['code'] === 'number') {
          providerCode = String(errObj['code']);
        }
        if (typeof errObj['type'] === 'string') {
          providerType = String(errObj['type']);
        }
      } else if (typeof json['message'] === 'string') {
        rawExtractedMessage = json['message'];
      }
    } catch {
      // Non-JSON response (e.g. HTML from reverse proxy or plain text).
      // Never store rawBody in client-facing details.
    }
  }

  // Parse retry-after header if present (in seconds)
  let retryAfterSeconds: number | undefined;
  if (retryAfterHeader) {
    const parsed = parseInt(retryAfterHeader, 10);
    if (!isNaN(parsed) && parsed > 0) {
      retryAfterSeconds = parsed;
    }
  }

  const sanitizedMessage = rawExtractedMessage
    ? sanitizeErrorMessage(rawExtractedMessage)
    : undefined;

  const message =
    sanitizedMessage && sanitizedMessage.length > 0
      ? sanitizedMessage
      : `Upstream provider "${provider}" returned HTTP ${status}: ${statusText}`;

  // Build safe allowlisted details dictionary
  const safeDetails: Record<string, unknown> = {
    provider,
    status,
  };
  if (providerCode) {
    safeDetails['code'] = sanitizeErrorMessage(providerCode);
  }
  if (providerType) {
    safeDetails['type'] = sanitizeErrorMessage(providerType);
  }

  switch (status) {
    case 400:
      return new RelayInvalidRequestError(message, { details: safeDetails });
    case 401:
    case 403:
      return new RelayAuthenticationError(message, { details: safeDetails });
    case 404:
      return new RelayInvalidRequestError(
        `Model or resource not found on provider "${provider}": ${message}`,
        { details: safeDetails },
      );
    case 429:
      return new RelayRateLimitError(message, {
        details: safeDetails,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      });
    case 504:
      return new RelayTimeoutError(message, { details: safeDetails });
    case 502:
    case 503:
    default:
      return new RelayProviderUnavailableError(message, {
        statusCode: status === 503 ? 503 : 502,
        details: safeDetails,
      });
  }
}
