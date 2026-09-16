export interface ServerSentEvent {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
}

/**
 * Parses a Web Streams ReadableStream<Uint8Array> into an AsyncIterable of ServerSentEvents.
 * Handles split chunks, varied line endings (\r\n and \n), and multi-byte UTF-8 sequences.
 */
export async function* parseServerSentEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<ServerSentEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  let currentEvent: string | undefined;
  let currentData: string[] = [];
  let currentId: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Split into lines while preserving remaining incomplete line in buffer
      const lines = buffer.split(/\r\n|\r|\n/);
      // The last element is incomplete until next delimiter or EOF
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        // An empty line indicates the end of an SSE message block
        if (line === '') {
          if (currentData.length > 0) {
            yield {
              ...(currentEvent !== undefined ? { event: currentEvent } : {}),
              data: currentData.join('\n'),
              ...(currentId !== undefined ? { id: currentId } : {}),
            };
            currentEvent = undefined;
            currentData = [];
            currentId = undefined;
          }
          continue;
        }

        // Comment lines start with ':'
        if (line.startsWith(':')) {
          continue;
        }

        const colonIndex = line.indexOf(':');
        let field: string;
        let valueStr = '';

        if (colonIndex === -1) {
          field = line;
        } else {
          field = line.slice(0, colonIndex);
          valueStr = line.slice(colonIndex + 1);
          // Standard SSE format strips a single leading space after the colon
          if (valueStr.startsWith(' ')) {
            valueStr = valueStr.slice(1);
          }
        }

        switch (field) {
          case 'data':
            currentData.push(valueStr);
            break;
          case 'event':
            currentEvent = valueStr;
            break;
          case 'id':
            currentId = valueStr;
            break;
        }
      }
    }

    // Flush any remaining decoder state
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const remainingLines = buffer.split(/\r\n|\r|\n/);
      for (const line of remainingLines) {
        if (line.startsWith('data:')) {
          let val = line.slice(5);
          if (val.startsWith(' ')) {
            val = val.slice(1);
          }
          currentData.push(val);
        }
      }
    }

    // Yield any remaining un-dispatched event at EOF
    if (currentData.length > 0) {
      yield {
        ...(currentEvent !== undefined ? { event: currentEvent } : {}),
        data: currentData.join('\n'),
        ...(currentId !== undefined ? { id: currentId } : {}),
      };
    }
  } finally {
    reader.releaseLock();
  }
}
