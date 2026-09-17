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

  it('enforces maxRecords capacity bounding and evicts oldest records', () => {
    const sink = new InMemoryUsageSink({ maxRecords: 3 });

    for (let i = 1; i <= 5; i++) {
      sink.record({
        requestId: `req-${i}`,
        provider: 'qwen',
        model: 'qwen3-coder-30b',
        stream: false,
        startedAt: new Date(),
        durationMs: 100,
        statusCode: 200,
        success: true,
      });
    }

    const records = sink.getRecords();
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.requestId)).toEqual(['req-3', 'req-4', 'req-5']);
  });
});
