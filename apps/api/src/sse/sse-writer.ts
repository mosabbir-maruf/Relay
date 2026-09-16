import { once } from 'node:events';
import type { FastifyReply } from 'fastify';
import type { ChatCompletionChunk, TokenUsage } from '@relay/core';

export interface SseStreamResult {
  readonly usage?: TokenUsage | undefined;
  readonly error?: { readonly message: string; readonly code: string } | undefined;
  readonly aborted: boolean;
}

function formatSseChunk(chunk: ChatCompletionChunk): string {
  const openAiChunk = {
    id: chunk.id,
    object: 'chat.completion.chunk',
    created: chunk.created,
    model: chunk.model,
    choices: [
      {
        index: 0,
        delta: chunk.delta,
        finish_reason: chunk.finishReason,
      },
    ],
    ...(chunk.usage ? { usage: chunk.usage } : {}),
  };

  return `data: ${JSON.stringify(openAiChunk)}\n\n`;
}

/**
 * Pipes normalized ChatCompletionChunks directly to the client as OpenAI-compatible SSE.
 *
 * Hardened behavior:
 * 1. Pre-fetches the first chunk before committing HTTP 200 headers. If upstream fails immediately
 *    (e.g. 401, 429, 502), the error bubbles to the global error handler so the client receives the real HTTP status.
 * 2. Collects token usage metadata from chunks if provided by upstream without buffering entire stream text.
 * 3. Emits standard OpenAI SSE error events if an error occurs mid-stream after headers were committed.
 * 4. Respects socket backpressure via drain events and cancellation via AbortSignal.
 * 5. Returns SseStreamResult to caller to enable precise telemetry recording upon stream closure.
 */
export async function writeSseStream(
  reply: FastifyReply,
  stream: AsyncIterable<ChatCompletionChunk>,
  signal: AbortSignal,
): Promise<SseStreamResult> {
  const iterator = stream[Symbol.asyncIterator]();

  // 1. Fetch first chunk before committing HTTP 200 headers.
  // If this throws, headers are not sent, and the caller can return the real HTTP error status.
  const firstResult = await iterator.next();

  if (signal.aborted || reply.raw.writableEnded) {
    return { aborted: true };
  }

  // 2. Commit SSE headers now that upstream connection has responded successfully
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let finalUsage: TokenUsage | undefined;
  let streamError: { readonly message: string; readonly code: string } | undefined;

  try {
    if (!firstResult.done) {
      if (firstResult.value.usage) {
        finalUsage = firstResult.value.usage;
      }

      const canContinue = reply.raw.write(formatSseChunk(firstResult.value));
      if (!canContinue) {
        await once(reply.raw, 'drain');
      }

      // 3. Process remaining stream chunks
      let result = await iterator.next();
      while (!result.done) {
        if (signal.aborted || reply.raw.writableEnded) {
          break;
        }

        if (result.value.usage) {
          finalUsage = result.value.usage;
        }

        const nextCanContinue = reply.raw.write(formatSseChunk(result.value));
        if (!nextCanContinue) {
          await once(reply.raw, 'drain');
        }

        result = await iterator.next();
      }
    }

    if (!signal.aborted && !reply.raw.writableEnded) {
      reply.raw.write('data: [DONE]\n\n');
    }
  } catch (err) {
    // Headers have already been sent; emit an OpenAI-compatible mid-stream error event
    if (!signal.aborted && !reply.raw.writableEnded) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      streamError = {
        message: errorMessage,
        code: 'stream_error',
      };
      const payload = {
        error: {
          message: errorMessage,
          type: 'stream_error',
          code: 'stream_error',
          param: null,
        },
      };
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  } finally {
    if (!reply.raw.writableEnded) {
      reply.raw.end();
    }
  }

  return {
    usage: finalUsage,
    error: streamError,
    aborted: Boolean(signal.aborted),
  };
}
