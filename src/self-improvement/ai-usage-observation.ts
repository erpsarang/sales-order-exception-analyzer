export type AiUsageUnavailableReason =
  | "NO_ROLLOUT"
  | "NO_PERSISTED_USAGE";

export interface AiUsageUnavailableObservation {
  readonly schemaVersion: 1;
  readonly kind: "ai-token-usage-unavailable";
  readonly stage: string;
  readonly provider: "openai-codex-action";
  readonly source: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly jobName: string;
  };
  readonly reason: AiUsageUnavailableReason;
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

export function createAiUsageUnavailableObservation(input: {
  readonly stage: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly jobName: string;
  readonly reason: AiUsageUnavailableReason;
}): AiUsageUnavailableObservation {
  const stage = input.stage.trim();
  const jobName = input.jobName.trim();
  if (!stage) throw new Error("stage must be non-empty");
  if (!jobName) throw new Error("jobName must be non-empty");

  return Object.freeze({
    schemaVersion: 1,
    kind: "ai-token-usage-unavailable",
    stage,
    provider: "openai-codex-action",
    source: Object.freeze({
      runId: positiveSafeInteger("runId", input.runId),
      runAttempt: positiveSafeInteger("runAttempt", input.runAttempt),
      jobName,
    }),
    reason: input.reason,
  });
}
