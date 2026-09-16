import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { isRateLimitError, isRelayError } from '@relay/core';

/**
 * Global Fastify error handler that normalizes domain and HTTP errors
 * into OpenAI-compatible error payloads.
 */
export function globalErrorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (isRelayError(error)) {
    if (isRateLimitError(error) && error.retryAfterSeconds !== undefined) {
      reply.header('retry-after', String(error.retryAfterSeconds));
    }

    if (error.statusCode >= 500) {
      request.log.error({ err: error, code: error.code }, 'Relay gateway server error');
    } else {
      request.log.warn({ err: error, code: error.code }, 'Relay gateway client error');
    }

    reply.status(error.statusCode).send(error.toOpenAIError());
    return;
  }

  // Fastify Body Too Large (413)
  const isBodyTooLarge =
    ('code' in error && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') ||
    ('statusCode' in error && error.statusCode === 413);
  if (isBodyTooLarge) {
    request.log.warn({ err: error }, 'Request body exceeded size limit');
    reply.status(413).send({
      error: {
        message: 'Request payload exceeded maximum allowed size of 10MB.',
        type: 'invalid_request_error',
        code: 'payload_too_large',
        param: null,
      },
    });
    return;
  }

  // Fastify Schema Validation Error or Malformed JSON Body (400)
  const isClientBadRequest =
    ('validation' in error && error.validation) ||
    ('statusCode' in error && error.statusCode === 400);
  if (isClientBadRequest) {
    request.log.warn({ err: error }, 'Client request invalid or unparseable');
    reply.status(400).send({
      error: {
        message: error.message,
        type: 'invalid_request_error',
        code: 'invalid_request',
        param: null,
      },
    });
    return;
  }

  // Unexpected or unhandled internal error
  request.log.error(error, 'Unhandled server error');
  reply.status(500).send({
    error: {
      message: 'An unexpected internal error occurred.',
      type: 'internal_error',
      code: 'internal_error',
      param: null,
    },
  });
}
