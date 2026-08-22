export type StudioOperation = "files.upload" | "files.readiness" | "responses.create" | "responses.get" | "files.delete" | "agents.list";

export type StudioMetric = {
  operation: StudioOperation;
  logicalCalls: number;
  attempts: number;
  retries: number;
  durationMs: number;
  status?: number;
  retryReason?: string;
};

/** A collector belongs to one workflow run. It intentionally has no module state. */
export class StudioRunMetrics {
  private readonly records: StudioMetric[] = [];
  constructor(private readonly now: () => number = Date.now) {}

  begin(operation: StudioOperation): { finish: (input?: Partial<Omit<StudioMetric, "operation" | "logicalCalls" | "durationMs">>) => void } {
    const started = this.now();
    return {
      finish: (input = {}) => {
        this.records.push({
          operation,
          logicalCalls: 1,
          attempts: input.attempts ?? 1,
          retries: input.retries ?? 0,
          durationMs: this.now() - started,
          status: input.status,
          retryReason: input.retryReason,
        });
      },
    };
  }

  snapshot(): { logicalCalls: number; physicalAttempts: number; retries: number; operations: StudioMetric[] } {
    return {
      logicalCalls: this.records.reduce((total, record) => total + record.logicalCalls, 0),
      physicalAttempts: this.records.reduce((total, record) => total + record.attempts, 0),
      retries: this.records.reduce((total, record) => total + record.retries, 0),
      operations: this.records.map((record) => ({ ...record })),
    };
  }
}
