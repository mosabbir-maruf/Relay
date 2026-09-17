import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RelayInvalidRequestError,
  RelayRateLimitError,
  RelayRequestCancelledError,
  RelayTimeoutError,
} from '@relay/core';
import { GeminiProvider } from '../src/gemini/gemini-provider.js';

describe('GeminiProvider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('translates chat completion request and normalizes Gemini response', async () => {
    const mockGeminiResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Gemini response text' }],
            role: 'model',
          },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 8,
        totalTokenCount: 23,
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockGeminiResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const provider = new GeminiProvider({
      apiKey: 'gemini-test-key',
    });

    const result = await provider.chat({
      model: 'gemini-1.5-flash',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ],
      temperature: 0.7,
    });

    expect(result.provider).toBe('gemini');
    expect(result.model).toBe('gemini-1.5-flash');
    expect(result.message.content).toBe('Gemini response text');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.promptTokens).toBe(15);
    expect(result.usage.completionTokens).toBe(8);
    expect(result.usage.totalTokens).toBe(23);

    // Verify Gemini payload structure and header auth
    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    const url = fetchCall[0];
    const options = fetchCall[1];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
    );
    expect(url).not.toContain('key=');
    expect(options.headers['x-goog-api-key']).toBe('gemini-test-key');

    const sentBody = JSON.parse(options.body);
    expect(sentBody.systemInstruction.parts[0].text).toBe('You are a helpful assistant.');
    expect(sentBody.contents[0].role).toBe('user');
    expect(sentBody.contents[0].parts[0].text).toBe('Hello');
    expect(sentBody.generationConfig.temperature).toBe(0.7);
  });

  it('normalizes Gemini 400 error to RelayInvalidRequestError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: 'Invalid argument provided in request',
            status: 'INVALID_ARGUMENT',
          },
        }),
        {
          status: 400,
          statusText: 'Bad Request',
        },
      ),
    );

    const provider = new GeminiProvider({
      apiKey: 'test-key',
    });

    await expect(
      provider.chat({
        model: 'gemini-1.5-flash',
        messages: [{ role: 'user', content: 'test' }],
      }),
    ).rejects.toThrow(RelayInvalidRequestError);
  });

  it('normalizes Gemini 429 error to RelayRateLimitError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: 'Resource exhausted (quota exceeded)',
            status: 'RESOURCE_EXHAUSTED',
          },
        }),
        {
          status: 429,
          statusText: 'Too Many Requests',
        },
      ),
    );

    const provider = new GeminiProvider({
      apiKey: 'test-key',
    });

    await expect(
      provider.chat({
        model: 'gemini-1.5-flash',
        messages: [{ role: 'user', content: 'test' }],
      }),
    ).rejects.toThrow(RelayRateLimitError);
  });

  it('streams SSE chunks from streamGenerateContent and yields ChatCompletionChunks', async () => {
    const sseChunk1 = {
      candidates: [
        {
          content: { parts: [{ text: 'Hello' }], role: 'model' },
          finishReason: undefined,
        },
      ],
    };

    const sseChunk2 = {
      candidates: [
        {
          content: { parts: [{ text: ' world' }], role: 'model' },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 2,
        totalTokenCount: 7,
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

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const provider = new GeminiProvider({
      apiKey: 'test-key',
    });

    const chunks = [];
    for await (const chunk of provider.chatStream({
      model: 'gemini-1.5-flash',
      messages: [{ role: 'user', content: 'test' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.delta.content).toBe('Hello');
    expect(chunks[1]?.delta.content).toBe(' world');
    expect(chunks[1]?.finishReason).toBe('stop');
    expect(chunks[1]?.usage?.totalTokens).toBe(7);

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse',
    );
    expect(fetchCall[0]).not.toContain('key=');
    expect(fetchCall[1].headers['x-goog-api-key']).toBe('test-key');
  });

  it('uses x-goog-api-key header and no query key in healthCheck', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const provider = new GeminiProvider({
      apiKey: 'health-test-key',
    });

    const health = await provider.healthCheck();
    expect(health.isHealthy).toBe(true);

    const fetchCall = (globalThis.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(fetchCall[0]).not.toContain('key=');
    expect(fetchCall[1].headers['x-goog-api-key']).toBe('health-test-key');
  });

  it('throws RelayRequestCancelledError when signal is aborted with client_disconnect', async () => {
    const controller = new AbortController();
    controller.abort('client_disconnect');

    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

    const provider = new GeminiProvider({
      apiKey: 'test-key',
    });

    await expect(
      provider.chat(
        {
          model: 'gemini-1.5-flash',
          messages: [{ role: 'user', content: 'test' }],
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(RelayRequestCancelledError);
  });

  it('throws RelayTimeoutError when signal is aborted with timeout or standard AbortError', async () => {
    const controller = new AbortController();
    controller.abort('request_timeout');

    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

    const provider = new GeminiProvider({
      apiKey: 'test-key',
    });

    await expect(
      provider.chat(
        {
          model: 'gemini-1.5-flash',
          messages: [{ role: 'user', content: 'test' }],
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(RelayTimeoutError);
  });
});
