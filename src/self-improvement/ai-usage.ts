export interface CodexTokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

export type AiUsageSource =
  | {
      readonly runId: number;
      readonly runAttempt: number;
      readonly jobId: number;
    }
  | {
      readonly runId: number;
      readonly runAttempt: number;
      readonly jobName: string;
    };

export interface AiUsageRecord {
  readonly schemaVersion: 1;
  readonly kind: "ai-token-usage";
  readonly stage: string;
  readonly provider: "openai-codex-action";
  readonly source: AiUsageSource;
  readonly usage: CodexTokenUsage;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeSafeInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function optionalNonNegativeSafeInteger(name: string, value: unknown): number {
  return value === undefined ? 0 : nonNegativeSafeInteger(name, value);
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function normalizeUsage(
  usage: Record<string, unknown>,
  source: string,
): CodexTokenUsage {
  const inputTokens = nonNegativeSafeInteger(`${source}.input_tokens`, usage.input_tokens);
  const cachedInputTokens = nonNegativeSafeInteger(
    `${source}.cached_input_tokens`,
    usage.cached_input_tokens,
  );
  const cacheWriteInputTokens = optionalNonNegativeSafeInteger(
    `${source}.cache_write_input_tokens`,
    usage.cache_write_input_tokens,
  );
  const outputTokens = nonNegativeSafeInteger(`${source}.output_tokens`, usage.output_tokens);
  const reasoningOutputTokens = nonNegativeSafeInteger(
    `${source}.reasoning_output_tokens`,
    usage.reasoning_output_tokens,
  );
  const totalTokens =
    usage.total_tokens === undefined
      ? inputTokens + outputTokens
      : nonNegativeSafeInteger(`${source}.total_tokens`, usage.total_tokens);

  if (cachedInputTokens > inputTokens) {
    throw new Error("cached input tokens cannot exceed input tokens");
  }
  if (cacheWriteInputTokens > inputTokens) {
    throw new Error("cache-write input tokens cannot exceed input tokens");
  }
  if (reasoningOutputTokens > outputTokens) {
    throw new Error("reasoning output tokens cannot exceed output tokens");
  }

  return Object.freeze({
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  });
}

function cleanJsonCandidate(line: string): string | null {
  const withoutAnsi = line.replace(/\u001b\[[0-9;]*m/g, "");
  const marker = withoutAnsi.indexOf('{"type":"turn.completed"');
  if (marker < 0) return null;
  const candidate = withoutAnsi.slice(marker);
  const end = candidate.lastIndexOf("}");
  if (end < 0) return null;
  return candidate.slice(0, end + 1);
}

export function parseCodexTurnUsageFromLog(log: string): CodexTokenUsage {
  const completed: CodexTokenUsage[] = [];

  for (const line of log.split(/\r?\n/)) {
    const candidate = cleanJsonCandidate(line);
    if (!candidate) continue;

    let event: unknown;
    try {
      event = JSON.parse(candidate);
    } catch {
      throw new Error("Codex turn.completed JSONL event is malformed");
    }
    if (!record(event) || event.type !== "turn.completed") continue;
    if (!record(event.usage)) {
      throw new Error("Codex turn.completed usage is missing");
    }
    completed.push(normalizeUsage(event.usage, "usage"));
  }

  if (completed.length !== 1) {
    throw new Error(`expected exactly one Codex turn.completed usage event, found ${completed.length}`);
  }
  return completed[0]!;
}

export function parseCodexRolloutUsage(rolloutJsonl: string): CodexTokenUsage {
  let latestTokenCount: CodexTokenUsage | undefined;
  let latestUsageRecord: CodexTokenUsage | undefined;

  for (const [index, line] of rolloutJsonl.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;

    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch {
      throw new Error(`Codex rollout JSONL line ${index + 1} is malformed`);
    }
    if (!record(item) || !record(item.payload)) continue;

    if (item.type === "event_msg" && item.payload.type === "token_count") {
      const info = item.payload.info;
      if (info === null || info === undefined) continue;
      if (!record(info) || !record(info.total_token_usage)) {
        throw new Error("Codex rollout token_count total_token_usage is malformed");
      }
      latestTokenCount = normalizeUsage(
        info.total_token_usage,
        "token_count.info.total_token_usage",
      );
      continue;
    }

    if (item.type === "token_usage_record") {
      if (!record(item.payload.thread_token_usage)) {
        throw new Error("Codex rollout token_usage_record thread_token_usage is malformed");
      }
      latestUsageRecord = normalizeUsage(
        item.payload.thread_token_usage,
        "token_usage_record.thread_token_usage",
      );
    }
  }

  const usage = latestTokenCount ?? latestUsageRecord;
  if (!usage) {
    throw new Error("Codex rollout does not contain persisted token usage");
  }
  return usage;
}

export function createAiUsageRecord(input: {
  readonly stage: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly jobId?: number;
  readonly jobName?: string;
  readonly usage: CodexTokenUsage;
}): AiUsageRecord {
  if (!input.stage.trim()) throw new Error("stage must be non-empty");
  positiveSafeInteger("runId", input.runId);
  positiveSafeInteger("runAttempt", input.runAttempt);

  const hasJobId = input.jobId !== undefined;
  const hasJobName = input.jobName !== undefined;
  if (hasJobId === hasJobName) {
    throw new Error("exactly one of jobId or jobName is required");
  }

  const source: AiUsageSource = hasJobId
    ? {
        runId: input.runId,
        runAttempt: input.runAttempt,
        jobId: positiveSafeInteger("jobId", input.jobId!),
      }
    : {
        runId: input.runId,
        runAttempt: input.runAttempt,
        jobName: input.jobName!.trim(),
      };

  if ("jobName" in source && !source.jobName) {
    throw new Error("jobName must be non-empty");
  }

  return Object.freeze({
    schemaVersion: 1,
    kind: "ai-token-usage",
    stage: input.stage,
    provider: "openai-codex-action",
    source: Object.freeze(source),
    usage: Object.freeze({ ...input.usage }),
  });
}
