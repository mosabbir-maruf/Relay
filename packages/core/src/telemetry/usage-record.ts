/**
 * Normalized telemetry record captured for every chat completion request.
 */
export interface UsageRecord {
  readonly requestId: string;
  readonly provider: string;
  readonly model: string;
  readonly stream: boolean;
  readonly startedAt: Date;
  readonly durationMs: number;
  readonly statusCode: number;
  readonly success: boolean;
  readonly promptTokens?: number | undefined;
  readonly completionTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly errorCategory?: string | undefined;
  readonly requestedModel?: string | undefined;
  readonly attemptCount?: number | undefined;
}

/**
 * Pluggable telemetry sink abstraction for recording usage records.
 * Decouples telemetry capture from persistence (in-memory, file, database, queue).
 */
export interface UsageSink {
  record(record: UsageRecord): Promise<void> | void;
}

/**
 * Default in-memory usage sink suitable for testing, local telemetry inspection,
 * and lightweight operational diagnostics.
 */
export class InMemoryUsageSink implements UsageSink {
  private readonly records: UsageRecord[] = [];

  record(record: UsageRecord): void {
    this.records.push(record);
  }

  getRecords(): readonly UsageRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records.length = 0;
  }
}

/**
 * No-op usage sink for environments where telemetry recording is disabled.
 */
export class NoopUsageSink implements UsageSink {
  record(_record: UsageRecord): void {}
}
