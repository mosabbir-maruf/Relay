import { describe, expect, it } from 'vitest';
import { parseServerSentEvents } from '../src/http/sse-parser.js';

function createMockReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe('parseServerSentEvents', () => {
  it('parses standard single-line SSE data events', async () => {
    const stream = createMockReadableStream([
      'data: {"message":"hello"}\n\n',
      'data: {"message":"world"}\n\n',
    ]);

    const events = [];
    for await (const event of parseServerSentEvents(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]?.data).toBe('{"message":"hello"}');
    expect(events[1]?.data).toBe('{"message":"world"}');
  });

  it('handles events split across multiple read chunks', async () => {
    const stream = createMockReadableStream(['data: {"mess', 'age":"chunked"}\n', '\n']);

    const events = [];
    for await (const event of parseServerSentEvents(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('{"message":"chunked"}');
  });

  it('handles CRLF line breaks and comments', async () => {
    const stream = createMockReadableStream([
      ': ping comment\r\n',
      'id: 123\r\n',
      'event: update\r\n',
      'data: {"status":"ok"}\r\n\r\n',
    ]);

    const events = [];
    for await (const event of parseServerSentEvents(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe('123');
    expect(events[0]?.event).toBe('update');
    expect(events[0]?.data).toBe('{"status":"ok"}');
  });

  it('handles multi-line data payloads', async () => {
    const stream = createMockReadableStream(['data: line 1\n', 'data: line 2\n\n']);

    const events = [];
    for await (const event of parseServerSentEvents(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('line 1\nline 2');
  });
});
