import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RelayAuthenticationError,
  RelayRateLimitError,
  RelayRequestCancelledError,
  RelayTimeoutError,
} from '@relay/core';
import { OpenAICompatibleProvider } from '../src/openai-compatible/openai-compatible-provider.js';

describe('OpenAICompatibleProvider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('performs non-streaming chat completion and normalizes response', async () => {
    const mockResponse = {
      id: 'chatcmpl-test-123',
      object: 'chat.completion',
      created: 1726500000,
      model: 'qwen-coder-32b',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello from Qwen!',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 6,
        total_tokens: 18,
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const provider = new OpenAICompatibleProvider({
      id: 'local-qwen',
      name: 'Local Qwen',
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'test-key',
    });

    const result = await provider.chat({
      model: 'qwen-coder-32b',
      messages: [{ role: 'user', content: 'Say hello' }],
    });

    expect(result.id).toBe('chatcmpl-test-123');
    expect(result.provider).toBe('local-qwen');
    expect(result.model).toBe('qwen-coder-32b');
    expect(result.message.content).toBe('Hello from Qwen!');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.totalTokens).toBe(18);

    // Verify fetch was called with Authorization header and correct body
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:8000/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('normalizes HTTP 401 to RelayAuthenticationError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
        status: 401,
        statusText: 'Unauthorized',
      }),
    );

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost:8000/v1',
    });

    await expect(
      provider.chat({
        model: 'any-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(RelayAuthenticationError);
  });

  it('normalizes HTTP 429 with retry-after header to RelayRateLimitError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'retry-after': '45' },
      }),
    );

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost:8000/v1',
    });

    try {
      await provider.chat({
        model: 'any-model',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RelayRateLimitError);
      const rateLimitErr = err as RelayRateLimitError;
      expect(rateLimitErr.statusCode).toBe(429);
      expect(rateLimitErr.retryAfterSeconds).toBe(45);
    }
  });

  it('streams SSE chunks and yields normalized ChatCompletionChunk objects', async () => {
    const sseBody = [
      'data: {"id":"c-1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"id":"c-1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: {"id":"c-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseBody));
        controller.close();
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost:8000/v1',
    });

    const chunks = [];
    for await (const chunk of provider.chatStream({
      model: 'qwen-coder-32b',
      messages: [{ role: 'user', content: 'stream test' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.delta.content).toBe('Hello');
    expect(chunks[1]?.delta.content).toBe(' world');
    expect(chunks[2]?.finishReason).toBe('stop');
    expect(chunks[2]?.usage?.totalTokens).toBe(7);
  });

  it('supports unauthenticated endpoints without Authorization header and handles namespaced vLLM models', async () => {
    const mockResponse = {
      id: 'chatcmpl-vllm-qwen',
      object: 'chat.completion',
      created: 1726500000,
      model: 'Qwen/Qwen2.5-Coder-7B-Instruct',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'def hello_world():\n    return "Hello from Qwen on vLLM"',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 25,
        completion_tokens: 15,
        total_tokens: 40,
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    // Unauthenticated provider (no apiKey configured)
    const provider = new OpenAICompatibleProvider({
      id: 'vllm-qwen',
      name: 'vLLM Qwen Backend',
      baseUrl: 'http://localhost:8000/v1',
    });

    const result = await provider.chat({
      model: 'Qwen/Qwen2.5-Coder-7B-Instruct',
      messages: [{ role: 'user', content: 'Write a python function' }],
    });

    expect(result.model).toBe('Qwen/Qwen2.5-Coder-7B-Instruct');
    expect(result.message.content).toContain('Hello from Qwen on vLLM');
    expect(result.usage.totalTokens).toBe(40);

    // Verify Authorization header was NOT sent
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    const headers = fetchCall[1].headers;
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');

    // Verify payload preserved full namespaced model ID
    const sentBody = JSON.parse(fetchCall[1].body);
    expect(sentBody.model).toBe('Qwen/Qwen2.5-Coder-7B-Instruct');
  });

  it('throws RelayRequestCancelledError when signal is aborted with client_disconnect', async () => {
    const controller = new AbortController();
    controller.abort('client_disconnect');

    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost:8000/v1',
    });

    await expect(
      provider.chat(
        {
          model: 'qwen',
          messages: [{ role: 'user', content: 'test' }],
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(RelayRequestCancelledError);
  });

  it('throws RelayTimeoutError when signal is aborted with request_timeout', async () => {
    const controller = new AbortController();
    controller.abort('request_timeout');

    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost:8000/v1',
    });

    await expect(
      provider.chat(
        {
          model: 'qwen',
          messages: [{ role: 'user', content: 'test' }],
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(RelayTimeoutError);
  });
});
