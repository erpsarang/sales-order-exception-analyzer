import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createAiUsageRecord, parseCodexTurnUsageFromLog } from "./ai-usage.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경변수가 필요합니다`);
  return value;
}

function positiveIntegerEnv(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name}은 양의 정수여야 합니다`);
  }
  return value;
}

function writeOutput(name: string, value: string | number): void {
  appendFileSync(requiredEnv("GITHUB_OUTPUT"), `${name}=${String(value)}\n`, "utf8");
}

const log = readFileSync(requiredEnv("CODEX_JOB_LOG"), "utf8");
const usage = parseCodexTurnUsageFromLog(log);
const runId = positiveIntegerEnv("AI_USAGE_RUN_ID");
const runAttempt = positiveIntegerEnv("AI_USAGE_RUN_ATTEMPT");
const jobId = positiveIntegerEnv("AI_USAGE_JOB_ID");
const stage = requiredEnv("AI_USAGE_STAGE");

const record = createAiUsageRecord({
  stage,
  runId,
  runAttempt,
  jobId,
  usage,
});

writeFileSync(requiredEnv("AI_USAGE_JSON"), `${JSON.stringify(record, null, 2)}\n`, "utf8");

writeOutput("input_tokens", usage.inputTokens);
writeOutput("cached_input_tokens", usage.cachedInputTokens);
writeOutput("cache_write_input_tokens", usage.cacheWriteInputTokens);
writeOutput("output_tokens", usage.outputTokens);
writeOutput("reasoning_output_tokens", usage.reasoningOutputTokens);
writeOutput("total_tokens", usage.totalTokens);
writeOutput("artifact_name", `ai-usage-${stage}-${runId}-attempt-${runAttempt}`);
