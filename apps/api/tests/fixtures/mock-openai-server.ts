import http from 'node:http';
import { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export class MockOpenAIServer {
  private server?: http.Server;
  private originalFetch?: typeof globalThis.fetch;
  public baseUrl: string = '';
  public recordedRequests: RecordedRequest[] = [];
  public delayMs: number = 0;

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        await this.handleIncomingRequest(req, res);
      });

      this.server.on('error', reject);

      this.server.listen(0, '127.0.0.1', async () => {
        const address = this.server?.address() as AddressInfo;
        this.baseUrl = `http://127.0.0.1:${address.port}/v1`;

        // Check if environment restricts loopback socket connect (e.g. strict sandbox)
        let loopbackWorks = false;
        try {
          const testRes = await fetch(`http://127.0.0.1:${address.port}/models`);
          if (testRes.ok) {
            loopbackWorks = true;
          }
        } catch {
          loopbackWorks = false;
        }

        // If loopback TCP is denied by OS sandbox, install a transparent fetch handler for this baseUrl
        if (!loopbackWorks) {
          this.installFetchFallback();
        }

        resolve(this.baseUrl);
      });
    });
  }

  async close(): Promise<void> {
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = undefined;
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = undefined;
    }
  }

  private async handleIncomingRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf-8');
    let body: any = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }

    this.recordedRequests.push({
      method,
      url,
      headers: req.headers,
      body,
    });

    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    // Handle health / models check
    if (url.endsWith('/models') && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'mock-llama-3', object: 'model', created: 1726500000, owned_by: 'mock' }],
        }),
      );
      return;
    }

    // Handle chat completions
    if (url.includes('/chat/completions') && method === 'POST') {
      const firstMessage = body?.messages?.[0]?.content;

      // Error simulations
      if (firstMessage === 'simulate_rate_limit' || req.headers['x-mock-status'] === '429') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'retry-after': '30',
        });
        res.end(
          JSON.stringify({
            error: {
              message: 'Rate limit reached on mock upstream server',
              type: 'requests',
              code: 'rate_limit_exceeded',
            },
          }),
        );
        return;
      }

      if (firstMessage === 'simulate_auth_error' || req.headers['x-mock-status'] === '401') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: 'Invalid API key provided to mock OpenAI server',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          }),
        );
        return;
      }

      if (firstMessage === 'simulate_upstream_500' || req.headers['x-mock-status'] === '500') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'Internal server error in mock OpenAI server' },
          }),
        );
        return;
      }

      // Streaming response
      if (body?.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const model = body.model ?? 'mock-llama-3';
        const chunk1 = {
          id: 'chatcmpl-mock-chunk-1',
          object: 'chat.completion.chunk',
          created: 1726500000,
          model,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Mock ' },
              finish_reason: null,
            },
          ],
        };
        const chunk2 = {
          id: 'chatcmpl-mock-chunk-1',
          object: 'chat.completion.chunk',
          created: 1726500000,
          model,
          choices: [
            {
              index: 0,
              delta: { content: 'streaming response' },
              finish_reason: null,
            },
          ],
        };
        const chunk3 = {
          id: 'chatcmpl-mock-chunk-1',
          object: 'chat.completion.chunk',
          created: 1726500000,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            total_tokens: 16,
          },
        };

        res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk3)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // Non-streaming response
      const model = body?.model ?? 'mock-llama-3';
      const promptContent = typeof firstMessage === 'string' ? firstMessage : 'Hello';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock-resp-1',
          object: 'chat.completion',
          created: 1726500000,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: `Mock OpenAI response: ${promptContent}`,
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 14,
            completion_tokens: 6,
            total_tokens: 20,
          },
        }),
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found in mock OpenAI server' } }));
  }

  private installFetchFallback(): void {
    if (this.originalFetch) return;
    this.originalFetch = globalThis.fetch;
    const basePrefix = this.baseUrl;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (!urlStr.startsWith(basePrefix) && !urlStr.includes(this.baseUrl.replace(/\/v1$/, ''))) {
        return this.originalFetch!(input, init);
      }

      const method = (init?.method ?? 'GET').toUpperCase();
      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => {
            headers[k.toLowerCase()] = v;
          });
        } else if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers) {
            headers[k.toLowerCase()] = v;
          }
        } else {
          for (const [k, v] of Object.entries(init.headers)) {
            headers[k.toLowerCase()] = String(v);
          }
        }
      }

      let body: any = null;
      if (init?.body) {
        try {
          body = JSON.parse(String(init.body));
        } catch {
          body = init.body;
        }
      }

      this.recordedRequests.push({
        method,
        url: urlStr,
        headers,
        body,
      });

      if (this.delayMs > 0) {
        await new Promise((r, reject) => {
          const timer = setTimeout(r, this.delayMs);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        });
      }

      if (init?.signal?.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError');
      }

      // Models
      if (urlStr.endsWith('/models') && method === 'GET') {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'mock-llama-3', object: 'model', created: 1726500000, owned_by: 'mock' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Chat completions
      if (urlStr.includes('/chat/completions') && method === 'POST') {
        const firstMessage = body?.messages?.[0]?.content;

        if (firstMessage === 'simulate_rate_limit' || headers['x-mock-status'] === '429') {
          return new Response(
            JSON.stringify({
              error: {
                message: 'Rate limit reached on mock upstream server',
                type: 'requests',
                code: 'rate_limit_exceeded',
              },
            }),
            {
              status: 429,
              headers: {
                'Content-Type': 'application/json',
                'retry-after': '30',
              },
            },
          );
        }

        if (firstMessage === 'simulate_auth_error' || headers['x-mock-status'] === '401') {
          return new Response(
            JSON.stringify({
              error: {
                message: 'Invalid API key provided to mock OpenAI server',
                type: 'invalid_request_error',
                code: 'invalid_api_key',
              },
            }),
            {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }

        if (firstMessage === 'simulate_upstream_500' || headers['x-mock-status'] === '500') {
          return new Response(
            JSON.stringify({
              error: { message: 'Internal server error in mock OpenAI server' },
            }),
            {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }

        if (body?.stream) {
          const model = body.model ?? 'mock-llama-3';
          const chunk1 = {
            id: 'chatcmpl-mock-chunk-1',
            object: 'chat.completion.chunk',
            created: 1726500000,
            model,
            choices: [
              { index: 0, delta: { role: 'assistant', content: 'Mock ' }, finish_reason: null },
            ],
          };
          const chunk2 = {
            id: 'chatcmpl-mock-chunk-1',
            object: 'chat.completion.chunk',
            created: 1726500000,
            model,
            choices: [{ index: 0, delta: { content: 'streaming response' }, finish_reason: null }],
          };
          const chunk3 = {
            id: 'chatcmpl-mock-chunk-1',
            object: 'chat.completion.chunk',
            created: 1726500000,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          };

          const sseBody = [
            `data: ${JSON.stringify(chunk1)}\n\n`,
            `data: ${JSON.stringify(chunk2)}\n\n`,
            `data: ${JSON.stringify(chunk3)}\n\n`,
            'data: [DONE]\n\n',
          ].join('');

          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(sseBody));
              controller.close();
            },
          });

          return new Response(stream, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
            },
          });
        }

        const model = body?.model ?? 'mock-llama-3';
        const promptContent = typeof firstMessage === 'string' ? firstMessage : 'Hello';
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-mock-resp-1',
            object: 'chat.completion',
            created: 1726500000,
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: `Mock OpenAI response: ${promptContent}`,
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 14,
              completion_tokens: 6,
              total_tokens: 20,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      return new Response(JSON.stringify({ error: { message: 'Not found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
  }
}
