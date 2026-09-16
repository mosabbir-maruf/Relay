import { describe, expect, it } from 'vitest';
import type { UsageRecord } from '../src/index.js';
import { InMemoryUsageSink, NoopUsageSink } from '../src/index.js';

describe('Telemetry & UsageRecord', () => {
  it('records and retrieves usage records using InMemoryUsageSink', () => {
    const sink = new InMemoryUsageSink();
    const record: UsageRecord = {
      requestId: 'req-123',
      provider: 'qwen',
      model: 'qwen3-coder-30b',
      stream: false,
      startedAt: new Date(),
      durationMs: 450,
      statusCode: 200,
      success: true,
      promptTokens: 25,
      completionTokens: 15,
      totalTokens: 40,
    };

    sink.record(record);
    const records = sink.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(record);

    sink.clear();
    expect(sink.getRecords()).toHaveLength(0);
  });

  it('handles NoopUsageSink without error', () => {
    const sink = new NoopUsageSink();
    const record: UsageRecord = {
      requestId: 'req-456',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      stream: true,
      startedAt: new Date(),
      durationMs: 120,
      statusCode: 504,
      success: false,
      errorCategory: 'request_timeout',
    };

    expect(() => sink.record(record)).not.toThrow();
  });
});
