import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Registers request ID tracking. Uses client-provided x-request-id header
 * or generates a new cryptographic UUID.
 */
export function registerRequestIdHook(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const headerValue = request.headers[REQUEST_ID_HEADER];
    const requestId =
      typeof headerValue === 'string' && headerValue.length > 0 ? headerValue : randomUUID();

    request.id = requestId;
  });

  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });
}
