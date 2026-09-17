import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { renderPlaygroundHtml } from '../playground/playground-html.js';

export const PLAYGROUND_CSP_HEADER = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Fastify plugin registering the browser-based AI Playground route.
 * Serves the self-contained SPA shell with strict security headers.
 */
export function createPlaygroundRoutes(): FastifyPluginAsync {
  return async function playgroundRoutes(app: FastifyInstance): Promise<void> {
    const handler = async (
      _request: unknown,
      reply: {
        type: (contentType: string) => typeof reply;
        header: (name: string, value: string) => typeof reply;
        status: (code: number) => typeof reply;
        send: (payload: unknown) => typeof reply;
      },
    ) => {
      reply
        .type('text/html; charset=utf-8')
        .header('Content-Security-Policy', PLAYGROUND_CSP_HEADER)
        .header('X-Content-Type-Options', 'nosniff')
        .header('X-Frame-Options', 'DENY')
        .header('Cache-Control', 'no-cache, no-store, must-revalidate')
        .header('Pragma', 'no-cache')
        .header('Expires', '0');

      return reply.status(200).send(renderPlaygroundHtml());
    };

    app.get('/playground', handler);
  };
}
