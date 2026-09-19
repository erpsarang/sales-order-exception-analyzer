import type { AiUsageRecord, CodexTokenUsage } from "./ai-usage.js";

export const BOUNDED_IMPLEMENT_RECORDED_STAGES = Object.freeze([
  "bounded-implement-attempt0",
  "bounded-implement-timeout-retry",
  "bounded-implement-repair1",
  "bounded-implement-repair2",
] as const);

export interface AiUsageSummary {
  readonly schemaVersion: 1;
  readonly kind: "ai-token-usage-summary";
  readonly scope: "bounded-implement-recorded";
  readonly source: {
    readonly runId: number;
    readonly runAttempt: number;
  };
  readonly recordedStages: readonly string[];
  readonly recordedCallCount: number;
  readonly usage: CodexTokenUsage;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function safeAdd(name: string, left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} exceeds safe integer range`);
  }
  return value;
}

export function parseAiUsageRecordJson(json: string): AiUsageRecord {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("AI usage record JSON is malformed");
  }
  if (!record(value)) throw new Error("AI usage record must be an object");
  if (value.schemaVersion !== 1 || value.kind !== "ai-token-usage") {
    throw new Error("unsupported AI usage record schema");
  }
  if (typeof value.stage !== "string" || !value.stage.trim()) {
    throw new Error("AI usage stage must be non-empty");
  }
  if (value.provider !== "openai-codex-action") {
    throw new Error("unsupported AI usage provider");
  }
  if (!record(value.source) || !record(value.usage)) {
    throw new Error("AI usage source/usage is malformed");
  }

  const runId = positiveSafeInteger("source.runId", value.source.runId);
  const runAttempt = positiveSafeInteger("source.runAttempt", value.source.runAttempt);
  const hasJobId = value.source.jobId !== undefined;
  const hasJobName = value.source.jobName !== undefined;
  if (hasJobId === hasJobName) {
    throw new Error("AI usage source must contain exactly one job identity");
  }

  const source = hasJobId
    ? {
        runId,
        runAttempt,
        jobId: positiveSafeInteger("source.jobId", value.source.jobId),
      }
    : {
        runId,
        runAttempt,
        jobName:
          typeof value.source.jobName === "string" && value.source.jobName.trim()
            ? value.source.jobName.trim()
            : (() => {
                throw new Error("source.jobName must be non-empty");
              })(),
      };

  const usage: CodexTokenUsage = {
    inputTokens: nonNegativeSafeInteger("usage.inputTokens", value.usage.inputTokens),
    cachedInputTokens: nonNegativeSafeInteger(
      "usage.cachedInputTokens",
      value.usage.cachedInputTokens,
    ),
    cacheWriteInputTokens: nonNegativeSafeInteger(
      "usage.cacheWriteInputTokens",
      value.usage.cacheWriteInputTokens,
    ),
    outputTokens: nonNegativeSafeInteger("usage.outputTokens", value.usage.outputTokens),
    reasoningOutputTokens: nonNegativeSafeInteger(
      "usage.reasoningOutputTokens",
      value.usage.reasoningOutputTokens,
    ),
    totalTokens: nonNegativeSafeInteger("usage.totalTokens", value.usage.totalTokens),
  };

  if (usage.cachedInputTokens > usage.inputTokens) {
    throw new Error("cached input tokens cannot exceed input tokens");
  }
  if (usage.cacheWriteInputTokens > usage.inputTokens) {
    throw new Error("cache-write input tokens cannot exceed input tokens");
  }
  if (usage.reasoningOutputTokens > usage.outputTokens) {
    throw new Error("reasoning output tokens cannot exceed output tokens");
  }

  return Object.freeze({
    schemaVersion: 1,
    kind: "ai-token-usage",
    stage: value.stage,
    provider: "openai-codex-action",
    source: Object.freeze(source),
    usage: Object.freeze(usage),
  });
}

export function summarizeBoundedImplementRecordedUsage(input: {
  readonly runId: number;
  readonly runAttempt: number;
  readonly records: readonly AiUsageRecord[];
}): AiUsageSummary {
  const runId = positiveSafeInteger("runId", input.runId);
  const runAttempt = positiveSafeInteger("runAttempt", input.runAttempt);
  const allowed = new Set<string>(BOUNDED_IMPLEMENT_RECORDED_STAGES);
  const seen = new Set<string>();
  const totals: {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
  } = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };

  for (const usageRecord of input.records) {
    if (!allowed.has(usageRecord.stage)) {
      throw new Error(`unexpected bounded IMPLEMENT usage stage: ${usageRecord.stage}`);
    }
    if (seen.has(usageRecord.stage)) {
      throw new Error(`duplicate bounded IMPLEMENT usage stage: ${usageRecord.stage}`);
    }
    if (
      usageRecord.source.runId !== runId ||
      usageRecord.source.runAttempt !== runAttempt
    ) {
      throw new Error("bounded IMPLEMENT usage run identity mismatch");
    }
    seen.add(usageRecord.stage);

    totals.inputTokens = safeAdd(
      "inputTokens",
      totals.inputTokens,
      usageRecord.usage.inputTokens,
    );
    totals.cachedInputTokens = safeAdd(
      "cachedInputTokens",
      totals.cachedInputTokens,
      usageRecord.usage.cachedInputTokens,
    );
    totals.cacheWriteInputTokens = safeAdd(
      "cacheWriteInputTokens",
      totals.cacheWriteInputTokens,
      usageRecord.usage.cacheWriteInputTokens,
    );
    totals.outputTokens = safeAdd(
      "outputTokens",
      totals.outputTokens,
      usageRecord.usage.outputTokens,
    );
    totals.reasoningOutputTokens = safeAdd(
      "reasoningOutputTokens",
      totals.reasoningOutputTokens,
      usageRecord.usage.reasoningOutputTokens,
    );
    totals.totalTokens = safeAdd(
      "totalTokens",
      totals.totalTokens,
      usageRecord.usage.totalTokens,
    );
  }

  const recordedStages = BOUNDED_IMPLEMENT_RECORDED_STAGES.filter((stage) => seen.has(stage));

  return Object.freeze({
    schemaVersion: 1,
    kind: "ai-token-usage-summary",
    scope: "bounded-implement-recorded",
    source: Object.freeze({ runId, runAttempt }),
    recordedStages: Object.freeze([...recordedStages]),
    recordedCallCount: recordedStages.length,
    usage: Object.freeze({ ...totals }),
  });
}
