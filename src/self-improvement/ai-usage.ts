export interface CodexTokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

export interface AiUsageRecord {
  readonly schemaVersion: 1;
  readonly kind: "ai-token-usage";
  readonly stage: string;
  readonly provider: "openai-codex-action";
  readonly source: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly jobId: number;
  };
  readonly usage: CodexTokenUsage;
}

function nonNegativeSafeInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
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
    if (typeof event !== "object" || event === null || Array.isArray(event)) continue;

    const record = event as Record<string, unknown>;
    if (record.type !== "turn.completed") continue;
    if (typeof record.usage !== "object" || record.usage === null || Array.isArray(record.usage)) {
      throw new Error("Codex turn.completed usage is missing");
    }

    const usage = record.usage as Record<string, unknown>;
    const inputTokens = nonNegativeSafeInteger("usage.input_tokens", usage.input_tokens);
    const cachedInputTokens = nonNegativeSafeInteger(
      "usage.cached_input_tokens",
      usage.cached_input_tokens,
    );
    const outputTokens = nonNegativeSafeInteger("usage.output_tokens", usage.output_tokens);
    const reasoningOutputTokens = nonNegativeSafeInteger(
      "usage.reasoning_output_tokens",
      usage.reasoning_output_tokens,
    );

    if (cachedInputTokens > inputTokens) {
      throw new Error("cached input tokens cannot exceed input tokens");
    }
    if (reasoningOutputTokens > outputTokens) {
      throw new Error("reasoning output tokens cannot exceed output tokens");
    }

    completed.push(Object.freeze({
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens: inputTokens + outputTokens,
    }));
  }

  if (completed.length !== 1) {
    throw new Error(`expected exactly one Codex turn.completed usage event, found ${completed.length}`);
  }
  return completed[0]!;
}

export function createAiUsageRecord(input: {
  readonly stage: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly jobId: number;
  readonly usage: CodexTokenUsage;
}): AiUsageRecord {
  if (!input.stage.trim()) throw new Error("stage must be non-empty");
  positiveSafeInteger("runId", input.runId);
  positiveSafeInteger("runAttempt", input.runAttempt);
  positiveSafeInteger("jobId", input.jobId);

  return Object.freeze({
    schemaVersion: 1,
    kind: "ai-token-usage",
    stage: input.stage,
    provider: "openai-codex-action",
    source: Object.freeze({
      runId: input.runId,
      runAttempt: input.runAttempt,
      jobId: input.jobId,
    }),
    usage: Object.freeze({ ...input.usage }),
  });
}
