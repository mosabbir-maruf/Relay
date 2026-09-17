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
  let readerCompleted = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        readerCompleted = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Index-based line scanner: avoids regex overhead and intermediate array allocation
      let lineStart = 0;
      while (lineStart < buffer.length) {
        let lineEnd = -1;
        let delimiterLength = 1;

        for (let i = lineStart; i < buffer.length; i++) {
          const code = buffer.charCodeAt(i);
          if (code === 10) {
            // \n (LF)
            lineEnd = i;
            delimiterLength = 1;
            break;
          }
          if (code === 13) {
            // \r (CR)
            if (i + 1 < buffer.length) {
              if (buffer.charCodeAt(i + 1) === 10) {
                // \r\n (CRLF)
                lineEnd = i;
                delimiterLength = 2;
              } else {
                // lone \r
                lineEnd = i;
                delimiterLength = 1;
              }
              break;
            } else {
              // \r at the very end of buffer: wait for next chunk to determine if \n follows
              break;
            }
          }
        }

        if (lineEnd === -1) {
          break;
        }

        const line = buffer.slice(lineStart, lineEnd);
        lineStart = lineEnd + delimiterLength;

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
        if (line.charCodeAt(0) === 58) {
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
          if (valueStr.charCodeAt(0) === 32) {
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

      // Keep only incomplete line remainder in buffer
      buffer = lineStart > 0 ? buffer.slice(lineStart) : buffer;
    }

    // Flush any remaining decoder state
    buffer += decoder.decode();
    if (buffer.length > 0) {
      let lineStart = 0;
      while (lineStart < buffer.length) {
        let lineEnd = -1;
        let delimiterLength = 1;

        for (let i = lineStart; i < buffer.length; i++) {
          const code = buffer.charCodeAt(i);
          if (code === 10) {
            lineEnd = i;
            delimiterLength = 1;
            break;
          }
          if (code === 13) {
            if (i + 1 < buffer.length && buffer.charCodeAt(i + 1) === 10) {
              lineEnd = i;
              delimiterLength = 2;
            } else {
              lineEnd = i;
              delimiterLength = 1;
            }
            break;
          }
        }

        const isLastLine = lineEnd === -1;
        const line = isLastLine ? buffer.slice(lineStart) : buffer.slice(lineStart, lineEnd);
        lineStart = isLastLine ? buffer.length : lineEnd + delimiterLength;

        if (line.startsWith('data:')) {
          let val = line.slice(5);
          if (val.charCodeAt(0) === 32) {
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
    try {
      if (!readerCompleted) {
        // Cancel upstream reader only on premature termination / consumer break
        await reader.cancel();
      }
    } catch {
      // Ignore cancellation errors
    } finally {
      reader.releaseLock();
    }
  }
}
