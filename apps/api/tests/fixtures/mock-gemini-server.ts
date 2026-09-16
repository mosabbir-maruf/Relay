import http from 'node:http';
import { AddressInfo } from 'node:net';

export interface RecordedGeminiRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export class MockGeminiServer {
  private server?: http.Server;
  private originalFetch?: typeof globalThis.fetch;
  public baseUrl: string = '';
  public recordedRequests: RecordedGeminiRequest[] = [];
  public delayMs: number = 0;

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        await this.handleIncomingRequest(req, res);
      });

      this.server.on('error', reject);

      this.server.listen(0, '127.0.0.1', async () => {
        const address = this.server?.address() as AddressInfo;
        this.baseUrl = `http://127.0.0.1:${address.port}`;

        let loopbackWorks = false;
        try {
          const testRes = await fetch(`http://127.0.0.1:${address.port}/v1beta/models`);
          if (testRes.ok) {
            loopbackWorks = true;
          }
        } catch {
          loopbackWorks = false;
        }

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

    if (url.includes(':generateContent') && method === 'POST') {
      const firstContent = body?.contents?.[0]?.parts?.[0]?.text;

      if (firstContent === 'simulate_rate_limit' || req.headers['x-mock-status'] === '429') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 429,
              message: 'Resource exhausted on mock Gemini server',
              status: 'RESOURCE_EXHAUSTED',
            },
          }),
        );
        return;
      }

      if (firstContent === 'simulate_invalid_request' || req.headers['x-mock-status'] === '400') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 400,
              message: 'Invalid argument provided to mock Gemini server',
              status: 'INVALID_ARGUMENT',
            },
          }),
        );
        return;
      }

      const promptText = typeof firstContent === 'string' ? firstContent : 'Hello';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: `Mock Gemini response: ${promptText}` }],
                role: 'model',
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15,
          },
        }),
      );
      return;
    }

    if (url.includes(':streamGenerateContent') && method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const sseChunk1 = {
        candidates: [
          {
            content: { parts: [{ text: 'Mock Gemini ' }], role: 'model' },
            finishReason: undefined,
          },
        ],
      };
      const sseChunk2 = {
        candidates: [
          {
            content: { parts: [{ text: 'streaming response' }], role: 'model' },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 4,
          totalTokenCount: 14,
        },
      };

      res.write(`data: ${JSON.stringify(sseChunk1)}\n\n`);
      res.write(`data: ${JSON.stringify(sseChunk2)}\n\n`);
      res.end();
      return;
    }

    if (url.includes('/models') && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' }],
        }),
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found in mock Gemini server' } }));
  }

  private installFetchFallback(): void {
    if (this.originalFetch) return;
    this.originalFetch = globalThis.fetch;
    const basePrefix = this.baseUrl;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (!urlStr.startsWith(basePrefix)) {
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

      if (urlStr.includes(':generateContent') && method === 'POST') {
        const firstContent = body?.contents?.[0]?.parts?.[0]?.text;

        if (firstContent === 'simulate_rate_limit' || headers['x-mock-status'] === '429') {
          return new Response(
            JSON.stringify({
              error: {
                code: 429,
                message: 'Resource exhausted on mock Gemini server',
                status: 'RESOURCE_EXHAUSTED',
              },
            }),
            { status: 429, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (firstContent === 'simulate_invalid_request' || headers['x-mock-status'] === '400') {
          return new Response(
            JSON.stringify({
              error: {
                code: 400,
                message: 'Invalid argument provided to mock Gemini server',
                status: 'INVALID_ARGUMENT',
              },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const promptText = typeof firstContent === 'string' ? firstContent : 'Hello';
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: `Mock Gemini response: ${promptText}` }],
                  role: 'model',
                },
                finishReason: 'STOP',
                index: 0,
              },
            ],
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 5,
              totalTokenCount: 15,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (urlStr.includes(':streamGenerateContent') && method === 'POST') {
        const sseChunk1 = {
          candidates: [
            {
              content: { parts: [{ text: 'Mock Gemini ' }], role: 'model' },
              finishReason: undefined,
            },
          ],
        };
        const sseChunk2 = {
          candidates: [
            {
              content: { parts: [{ text: 'streaming response' }], role: 'model' },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 4,
            totalTokenCount: 14,
          },
        };

        const sseBody = [
          `data: ${JSON.stringify(sseChunk1)}\n\n`,
          `data: ${JSON.stringify(sseChunk2)}\n\n`,
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

      if (urlStr.includes('/models') && method === 'GET') {
        return new Response(
          JSON.stringify({
            models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response(JSON.stringify({ error: { message: 'Not found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
  }
}
