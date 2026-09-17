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

  it('handles lone CR line breaks', async () => {
    const stream = createMockReadableStream(['data: {"type":"cr"}\r\r']);

    const events = [];
    for await (const event of parseServerSentEvents(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('{"type":"cr"}');
  });

  it('handles multibyte UTF-8 characters split across byte chunks', async () => {
    const encoder = new TextEncoder();
    const rocketBytes = encoder.encode('🚀'); // 4 bytes
    const part1 = encoder.encode('data: {"icon":"');
    const part2 = rocketBytes.subarray(0, 2); // first 2 bytes of 🚀
    const part3 = rocketBytes.subarray(2); // remaining 2 bytes of 🚀
    const part4 = encoder.encode('"}\n\n');

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(part1);
        controller.enqueue(part2);
        controller.enqueue(part3);
        controller.enqueue(part4);
        controller.close();
      },
    });

    const events = [];
    for await (const event of parseServerSentEvents(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('{"icon":"🚀"}');
  });

  it('safely cancels reader on premature consumer exit without leaking locks', async () => {
    let cancelCalled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: 1\n\ndata: 2\n\ndata: 3\n\n'));
      },
      cancel() {
        cancelCalled = true;
      },
    });

    for await (const event of parseServerSentEvents(stream)) {
      if (event.data === '1') {
        break; // Break early
      }
    }

    expect(cancelCalled).toBe(true);
  });
});
